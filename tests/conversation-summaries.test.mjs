import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.mjs';
import { Service } from '../server/service.mjs';

function fixture(t, provider) {
  const dir = mkdtempSync(join(tmpdir(), 'xingxi-summary-'));
  let store = new Store(join(dir, 'test.sqlite'));
  const service = new Service(store, dir, provider);
  service.saveSettings({ key: 'sk-test-not-real' });
  const space = store.createSpace({ name: '虚构摘要测试' });
  const session = store.openSession(space.id, { binding: 'stable' });
  const add = (body, role = 'user') =>
    store.append(space.id, session.id, { body, role, clientId: crypto.randomUUID() });
  t.after(async () => {
    await service.queue;
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    store,
    service,
    space,
    session,
    add,
    reopen() {
      store.close();
      store = new Store(join(dir, 'test.sqlite'));
      service.store = store;
      return store;
    },
  };
}
const item = (message, body = '用户表示这是假设，尚未决定。') => ({
  role: message.role,
  title: '虚构月桂讨论',
  body,
  evidence: [{ messageId: message.id, quote: message.body.slice(0, 500) }],
});

test('模型输出校验失败不留下部分摘要，排队期间撤回 Key 后不外发', async (t) => {
  let calls = 0;
  const f = fixture(t, async () => {
    calls++;
    return '{"items":[{"role":"user","title":"错误摘要","body":"不应保存","evidence":[{"messageId":"不存在","quote":"伪造"}]}]}';
  });
  f.add('虚构月桂原话');
  const failed = f.service.summarize(f.space.id, f.session.id);
  await f.service.queue;
  assert.equal(f.service.summaryJob(f.space.id, f.session.id, failed.id).status, 'failed');
  assert.equal(f.store.summaries.list(f.space.id, f.session.id).coverage.covered, 0);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM summary_search').get().n, 0);
  const queued = f.service.summarize(f.space.id, f.session.id);
  f.service.saveSettings({ key: '' });
  await f.service.queue;
  assert.equal(f.service.summaryJob(f.space.id, f.session.id, queued.id).status, 'failed');
  assert.equal(calls, 1);
});
function create(f, items) {
  return f.store.summaries.create(
    f.space.id,
    f.session.id,
    f.store.summaries.nextBatch(f.space.id, f.session.id),
    items,
  );
}
function accept(f, summary) {
  return f.store.summaries.review(f.space.id, f.session.id, summary.id, {
    revision: summary.revision,
    status: 'accepted',
  });
}

test('逐字出处与角色校验原子执行，待审阅不进入召回，修订和归档实时生效', (t) => {
  const f = fixture(t);
  const user = f.add('虚构月桂测试：我还没决定。');
  const assistant = f.add('虚构月桂建议：可考虑分批交付。', 'assistant');
  assert.throws(() => create(f, [{ ...item(user), role: 'assistant' }]), /角色/);
  assert.throws(
    () => create(f, [{ ...item(user), evidence: [{ messageId: user.id, quote: '并不存在' }] }]),
    /逐字/,
  );
  assert.equal(f.store.summaries.cursor(f.session.id), 0);
  const draft = create(f, [item(user), item(assistant, '助手建议分批交付，用户尚未接受。')]);
  assert.deepEqual(f.store.summaries.context(f.space.id, '月桂'), []);
  const reviewed = accept(f, draft);
  const recalled = f.store.summaries.context(f.space.id, '月桂');
  assert.equal(recalled.length, 2);
  assert.equal(recalled.find((r) => r.role === 'assistant').evidence[0].messageId, assistant.id);
  assert.equal(f.store.context(f.space.id, '月桂').entries.length, 0);
  assert.throws(() => accept(f, draft), /已更新/);
  const other = f.store.createSpace({ name: '其他空间' });
  assert.deepEqual(f.store.summaries.context(other.id, ''), []);
  assert.throws(() => f.store.summaries.read(other.id, f.session.id, draft.id), /此空间/);
  assert.equal(
    f.store.summaries.context(f.space.id, '月桂', { excludeIds: [assistant.id] }).length,
    1,
  );
  f.store.summaries.review(f.space.id, f.session.id, draft.id, {
    revision: reviewed.revision,
    status: 'archived',
  });
  assert.deepEqual(f.store.summaries.context(f.space.id, '月桂'), []);
});

test('显式生成按40条/24000字符分批，复用活动任务，失败不推进覆盖进度', async (t) => {
  const calls = [];
  const f = fixture(t, async (input) => {
    calls.push(input);
    return JSON.stringify({ items: [] });
  });
  for (let i = 0; i < 45; i++) f.add(`月桂消息${i}`);
  const first = f.service.summarize(f.space.id, f.session.id);
  assert.equal(f.service.summarize(f.space.id, f.session.id).id, first.id);
  assert.throws(() => f.service.deleteSession(f.space.id, f.session.id), /正在整理/);
  await f.service.queue;
  assert.equal(JSON.parse(calls[0].messages[1].content).length, 40);
  assert.equal(f.store.summaries.list(f.space.id, f.session.id).coverage.covered, 40);
  f.service.provider = async () => {
    throw new Error('private upstream details');
  };
  const failed = f.service.summarize(f.space.id, f.session.id);
  await f.service.queue;
  assert.equal(
    f.service.summaryJob(f.space.id, f.session.id, failed.id).error,
    '整理失败，请稍后重试',
  );
  assert.equal(f.store.summaries.list(f.space.id, f.session.id).coverage.covered, 40);
  f.service.provider = async (input) => {
    calls.push(input);
    return '{"items":[]}';
  };
  f.service.summarize(f.space.id, f.session.id);
  await f.service.queue;
  assert.equal(JSON.parse(calls[1].messages[1].content).length, 5);
  assert.throws(() => f.service.summarize(f.space.id, f.session.id), /没有尚未整理/);
  for (let i = 0; i < 5; i++) f.add('长'.repeat(11000));
  assert.equal(f.store.summaries.nextBatch(f.space.id, f.session.id).length, 2);
});

test('已审阅的助手方案跨会话进入模型和参考快照，重启保留，关闭与删除传播', async (t) => {
  const calls = [];
  const f = fixture(t, async (input) => {
    calls.push(input);
    return '这只是此前助手建议，尚无用户决定。';
  });
  const original = f.add('虚构月桂建议：分批验收。', 'assistant');
  const draft = create(f, [item(original, '助手建议月桂分批验收，尚未确认。')]);
  accept(f, draft);
  const fresh = f.store.createSession(f.space.id);
  const reply = await f.service.reply(f.space.id, fresh.id, {
    body: '月桂方案？',
    clientId: 'question',
  });
  assert.equal(reply.summaryMemory[0].role, 'assistant');
  assert.ok(calls[0].messages[0].content.includes('不能当成用户决定'));
  const store = f.reopen();
  assert.equal(store.summaries.context(f.space.id, '月桂')[0].role, 'assistant');
  const trace = () =>
    store.replyEvidence
      .read(f.space.id, fresh.id, reply.message.id)
      .items.find((i) => i.kind === 'summary');
  store.updateSession(f.space.id, f.session.id, { recallEnabled: false });
  assert.equal(trace().state, 'disabled');
  assert.deepEqual(store.summaries.context(f.space.id, '月桂'), []);
  store.updateSession(f.space.id, f.session.id, { recallEnabled: true });
  store.updateSpace(f.space.id, { recallEnabled: false });
  assert.deepEqual(store.summaries.context(f.space.id, '月桂'), []);
  store.updateSpace(f.space.id, { recallEnabled: true });
  store.deleteSession(f.space.id, f.session.id);
  assert.equal(trace().state, 'deleted');
  assert.equal(store.db.prepare('SELECT count(*) n FROM summary_search').get().n, 0);
  assert.equal(
    store.db.prepare('SELECT payload FROM reply_evidence_items WHERE kind=?').get('summary')
      .payload,
    null,
  );
});

test('摘要数量与片段有界；原消息被删除时不重建摘要，修改保留当时参考', async (t) => {
  const f = fixture(t, async () => '虚构回复');
  const original = f.add('月桂'.repeat(300), 'assistant');
  const draft = create(
    f,
    Array.from({ length: 8 }, () => item(original, '月桂'.repeat(450))),
  );
  const reviewed = accept(f, draft);
  const context = f.store.summaries.context(f.space.id, '月桂');
  assert.equal(context.length, 4);
  assert.equal(context[0].body.length, 800);
  assert.equal(context[0].truncated, true);
  assert.equal(context[0].evidence[0].quote.length, 240);
  assert.equal(context[0].evidence[0].truncated, true);
  const current = f.store.createSession(f.space.id);
  const out = await f.service.reply(f.space.id, current.id, { body: '月桂', clientId: 'one' });
  f.store.summaries.review(f.space.id, f.session.id, draft.id, {
    revision: reviewed.revision,
    status: 'accepted',
    items: [item(original, '助手的新摘要')],
  });
  const trace = f.store.replyEvidence
    .read(f.space.id, current.id, out.message.id)
    .items.find((i) => i.kind === 'summary');
  assert.equal(trace.state, 'changed');
  assert.equal(trace.snapshot.body, context[0].body);
  const pendingMessage = f.add('新的待整理消息');
  const captured = f.store.summaries.nextBatch(f.space.id, f.session.id);
  f.store.db.prepare('DELETE FROM messages WHERE id=?').run(pendingMessage.id);
  assert.throws(
    () => f.store.summaries.create(f.space.id, f.session.id, captured, [item(pendingMessage)]),
    /已改变/,
  );
});

test('摘要目录使用覆盖游标，编辑错误整体回滚，服务重启使残余任务可重试', (t) => {
  const f = fixture(t);
  for (let i = 0; i < 23; i++) {
    const m = f.add(`月桂${i}`);
    create(f, [item(m)]);
  }
  const first = f.store.summaries.list(f.space.id, f.session.id);
  const next = f.store.summaries.list(f.space.id, f.session.id, { before: first.nextBefore });
  assert.equal(first.summaries.length, 20);
  assert.equal(new Set([...first.summaries, ...next.summaries].map((s) => s.id)).size, 23);
  const draft = f.store.summaries.read(f.space.id, f.session.id, first.summaries[0].id);
  assert.throws(
    () =>
      f.store.summaries.review(f.space.id, f.session.id, draft.id, {
        revision: 1,
        status: 'accepted',
        items: [{ ...draft.items[0], evidence: [] }],
      }),
    /出处|依据/,
  );
  assert.deepEqual(f.store.summaries.read(f.space.id, f.session.id, draft.id), draft);
  f.store.db
    .prepare('INSERT INTO summary_jobs VALUES(?,?,?,?,?,?,?)')
    .run(
      'stopped',
      f.session.id,
      'running',
      null,
      null,
      new Date().toISOString(),
      new Date().toISOString(),
    );
  const store = f.reopen();
  new Service(store, f.service.dir);
  assert.equal(
    store.db.prepare('SELECT status FROM summary_jobs WHERE id=?').get('stopped').status,
    'failed',
  );
});
