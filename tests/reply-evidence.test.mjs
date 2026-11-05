import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.mjs';
import { Service } from '../server/service.mjs';

function fixture(t, provider = async () => '按虚构测试的计划继续。') {
  const dir = mkdtempSync(join(tmpdir(), 'xingxi-evidence-'));
  let store = new Store(join(dir, 'test.sqlite'));
  const service = new Service(store, dir, provider);
  service.saveSettings({ key: 'sk-test-not-real' });
  const a = store.createSpace({ name: '虚构验收' });
  const b = store.createSpace({ name: '其他空间' });
  const old = store.createSession(a.id, '原始会话');
  const original = store.append(a.id, old.id, {
    role: 'user',
    body: '虚构计划：月桂周五交付。',
    clientId: 'old',
  });
  const current = store.createSession(a.id, '新会话');
  const source = store.ingest(a.id, {
    title: '虚构资料',
    body: '虚构计划：月桂周五交付。',
    origin: 'example',
  });
  const candidate = store.propose(a.id, {
    title: '月桂计划',
    body: source.body,
    kind: 'decision',
    evidence: [{ sourceId: source.id, quote: source.body }],
  });
  const entry = store.updateEntry(a.id, candidate.id, { revision: 1, status: 'accepted' });
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    store,
    service,
    a,
    b,
    old,
    original,
    current,
    entry,
    source,
    reopen() {
      store.close();
      store = new Store(join(dir, 'test.sqlite'));
      service.store = store;
      return store;
    },
  };
}
const request = { body: '月桂计划是什么？', clientId: 'new' };

test('回答参考跨重启保存；重试返回同一记录且没有额外模型调用；摘要和原文一致', async (t) => {
  const calls = [];
  const f = fixture(t, async (input) => {
    calls.push(input);
    return '月桂是虚构测试计划。';
  });
  const out = await f.service.reply(f.a.id, f.current.id, request);
  const trace = f.store.replyEvidence.read(f.a.id, f.current.id, out.message.id);
  assert.equal(trace.recorded, true);
  assert.equal(trace.model, calls[0].model);
  assert.equal(trace.items.length, 3);
  const memory = trace.items.find((i) => i.kind === 'knowledge').snapshot;
  assert.equal(memory.id, f.entry.id);
  assert.equal(memory.revision, 2);
  assert.ok(calls[0].messages[0].content.includes(memory.body));
  assert.equal(trace.items.find((i) => i.kind === 'conversation').snapshot.quote, f.original.body);
  assert.equal(trace.items.find((i) => i.kind === 'recent').snapshot.body, undefined);
  assert.ok(!JSON.stringify(trace).includes('sk-test'));
  const store = f.reopen();
  assert.deepEqual(store.replyEvidence.read(f.a.id, f.current.id, out.message.id), trace);
  const again = await f.service.reply(f.a.id, f.current.id, request);
  assert.equal(again.message.id, out.message.id);
  assert.deepEqual(again.conversationMemory, out.conversationMemory);
  assert.deepEqual(again.memoryIds, out.memoryIds);
  assert.equal(calls.length, 1);
  assert.throws(() => store.replyEvidence.read(f.b.id, f.current.id, out.message.id), /此空间/);
  assert.throws(() => store.replyEvidence.read(f.a.id, f.old.id, out.message.id), /此会话/);
  const manual = store.append(f.a.id, f.current.id, {
    role: 'assistant',
    body: '外部助手手动追加',
    clientId: 'external',
  });
  assert.equal(store.replyEvidence.read(f.a.id, f.current.id, manual.id).recorded, false);
});

test('知识更新或归档保留当时版本，关闭召回隐藏原话，删除会清理参考快照', async (t) => {
  const f = fixture(t);
  const out = await f.service.reply(f.a.id, f.current.id, request);
  const read = () => f.store.replyEvidence.read(f.a.id, f.current.id, out.message.id);
  f.store.updateEntry(f.a.id, f.entry.id, {
    title: '新版标题',
    body: '虚构计划修改了时间。',
    revision: 2,
  });
  const changed = read().items.find((i) => i.kind === 'knowledge');
  assert.equal(changed.state, 'changed');
  assert.equal(changed.snapshot.title, '月桂计划');
  assert.equal(changed.snapshot.body, f.source.body);
  f.store.updateEntry(f.a.id, f.entry.id, { revision: 3, status: 'archived' });
  assert.equal(read().items.find((i) => i.kind === 'knowledge').state, 'archived');
  f.store.updateSession(f.a.id, f.old.id, { recallEnabled: false });
  const disabled = read().items.find((i) => i.kind === 'conversation');
  assert.equal(disabled.state, 'disabled');
  assert.equal(disabled.snapshot, undefined);
  f.store.updateSession(f.a.id, f.old.id, { recallEnabled: true });
  f.store.updateSpace(f.a.id, { recallEnabled: false });
  assert.ok(
    read()
      .items.filter((i) => i.kind !== 'knowledge')
      .every((i) => i.state === 'disabled'),
  );
  f.store.updateSpace(f.a.id, { recallEnabled: true });
  f.store.deleteSession(f.a.id, f.old.id);
  assert.equal(read().items.find((i) => i.kind === 'conversation').state, 'deleted');
  assert.equal(
    f.store.db
      .prepare('SELECT payload FROM reply_evidence_items WHERE target_id=?')
      .get(f.original.id).payload,
    null,
  );
  assert.equal((await f.service.reply(f.a.id, f.current.id, request)).conversationMemory.length, 0);
  f.store.deleteSession(f.a.id, f.current.id);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM reply_evidence').get().n, 0);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM reply_evidence_items').get().n, 0);
});

test('生成期间删除被召回的会话，不会把已删除原话重新写回参考表', async (t) => {
  let finish;
  const f = fixture(
    t,
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = f.service.reply(f.a.id, f.current.id, request);
  f.service.deleteSession(f.a.id, f.old.id);
  finish('虚构测试回复');
  const out = await pending;
  assert.equal(out.conversationMemory.length, 0);
  const trace = f.store.replyEvidence.read(f.a.id, f.current.id, out.message.id);
  assert.equal(trace.items.find((i) => i.kind === 'conversation').state, 'deleted');
  assert.equal(
    f.store.db
      .prepare('SELECT payload FROM reply_evidence_items WHERE target_id=?')
      .get(f.original.id).payload,
    null,
  );
});

test('参考记录写入失败时回答一起回滚；模型失败不伪造记录', async (t) => {
  let calls = 0;
  const f = fixture(t, async () => {
    if (++calls === 1) throw new Error('model failure');
    return '已回答';
  });
  await assert.rejects(f.service.reply(f.a.id, f.current.id, request), /model failure/);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM reply_evidence').get().n, 0);
  const save = f.store.replyEvidence.save;
  f.store.replyEvidence.save = () => {
    throw new Error('disk failure');
  };
  await assert.rejects(f.service.reply(f.a.id, f.current.id, request), /disk failure/);
  assert.equal(f.store.session(f.a.id, f.current.id).messages.length, 1);
  f.store.replyEvidence.save = save;
  await f.service.reply(f.a.id, f.current.id, request);
  assert.equal(f.store.session(f.a.id, f.current.id).messages.length, 2);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM reply_evidence').get().n, 1);
});

test('记录只含实际进入字符预算的近期消息，有界且不参与后续召回', async (t) => {
  const calls = [];
  const f = fixture(t, async (input) => {
    calls.push(input);
    return '收到';
  });
  for (let i = 0; i < 25; i++)
    f.store.append(f.a.id, f.current.id, {
      role: 'assistant',
      body: `${i}独特助手建议` + '长'.repeat(11000),
      clientId: `long${i}`,
    });
  const out = await f.service.reply(f.a.id, f.current.id, request);
  const trace = f.store.replyEvidence.read(f.a.id, f.current.id, out.message.id);
  const recent = trace.items.filter((i) => i.kind === 'recent');
  assert.equal(recent.length, calls[0].messages.length - 1);
  assert.equal(recent.length, 2);
  assert.equal(recent[0].snapshot.role, 'assistant');
  assert.ok(JSON.stringify(trace).length < 12000);
  assert.equal(f.store.conversationContext(f.a.id, '独特助手建议').excerpts.length, 0);
});

test('重试标识遇到角色冲突时拒绝，不能把手动用户消息当成模型答案', async (t) => {
  let calls = 0;
  const f = fixture(t, async () => {
    calls++;
    return '不应调用';
  });
  for (const [requestRole, replyRole] of [
    ['user', 'user'],
    ['assistant', 'assistant'],
  ]) {
    const s = f.store.createSession(f.a.id);
    f.store.append(f.a.id, s.id, {
      role: requestRole,
      body: request.body,
      clientId: request.clientId,
    });
    f.store.append(f.a.id, s.id, {
      role: replyRole,
      body: '外部手动消息',
      clientId: `reply:${request.clientId}`,
    });
    await assert.rejects(f.service.reply(f.a.id, s.id, request), /消息标识已用于其他内容/);
  }
  assert.equal(calls, 0);
});
