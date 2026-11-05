import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.mjs';
import { Service } from '../server/service.mjs';

function fixture(t, provider = async () => '按已审阅变更执行。') {
  const dir = mkdtempSync(join(tmpdir(), 'xingxi-changes-'));
  let store = new Store(join(dir, 'xingxi.sqlite'));
  const service = new Service(store, dir, provider);
  service.saveSettings({ key: 'sk-test-not-real' });
  const a = store.createSpace({ name: '虚构变更' }),
    b = store.createSpace({ name: '其他空间' });
  const old = store.createSession(a.id),
    newer = store.createSession(a.id);
  const message = store.append(a.id, old.id, {
    role: 'user',
    body: '虚构月桂截止日为周五。',
    clientId: 'old',
  });
  const correction = store.append(a.id, newer.id, {
    role: 'user',
    body: '纠正虚构月桂截止日为周日，还未决定具体交付形式。',
    clientId: 'correction',
  });
  const source = store.ingest(a.id, { title: '月桂资料', body: message.body });
  const pending = store.propose(a.id, {
    title: '月桂截止日',
    body: source.body,
    kind: 'decision',
    evidence: [{ sourceId: source.id, quote: source.body }],
  });
  const entry = store.updateEntry(a.id, pending.id, { revision: 1, status: 'accepted' });
  const input = {
    kind: 'correction',
    title: '月桂截止日纠正',
    body: '虚构月桂截止日改为周日。',
    target: { kind: 'knowledge', id: entry.id, revision: entry.revision },
    source: { kind: 'conversation', id: correction.id, quote: correction.body },
    effectiveAt: '2020-01-01T00:00:00Z',
  };
  t.after(async () => {
    await service.queue;
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    store,
    service,
    a,
    b,
    old,
    newer,
    message,
    correction,
    entry,
    input,
    reopen() {
      store.close();
      store = new Store(join(dir, 'xingxi.sqlite'));
      service.store = store;
      return store;
    },
  };
}
const accept = (f, c) =>
  f.store.changes.review(f.a.id, c.id, { revision: c.revision, status: 'accepted' });

test('纠正候选不影响召回；审阅后覆盖指定旧版本，原文仍保存，新旧词均可命中变更', (t) => {
  const f = fixture(t);
  const c = f.store.changes.propose(f.a.id, f.input);
  assert.equal(f.store.context(f.a.id, '月桂').entries.length, 1);
  assert.equal(f.store.changes.context(f.a.id, '月桂').length, 0);
  accept(f, c);
  assert.equal(f.store.context(f.a.id, '月桂').entries.length, 0);
  assert.equal(f.store.changes.context(f.a.id, '周五')[0].id, c.id);
  assert.equal(f.store.changes.context(f.a.id, '周日')[0].source.quote, f.correction.body);
  assert.equal(f.store.entry(f.a.id, f.entry.id).body, '虚构月桂截止日为周五。');
  assert.equal(f.store.changes.context(f.b.id, '月桂').length, 0);
  assert.throws(() => f.store.changes.read(f.b.id, c.id), /此空间/);
  assert.throws(() => accept(f, c), /已更新/);
  const next = f.reopen();
  assert.equal(next.changes.context(f.a.id, '周日')[0].id, c.id);
  assert.equal(next.context(f.a.id, '月桂').entries.length, 0);
});

test('时间变化不提前生效，同目标只采用最新生效记录，冲突隔离旧结论', (t) => {
  const f = fixture(t);
  const first = accept(f, f.store.changes.propose(f.a.id, f.input));
  const future = accept(
    f,
    f.store.changes.propose(f.a.id, {
      ...f.input,
      kind: 'change',
      body: '虚构的未来计划改为周一。',
      effectiveAt: '2099-01-01T00:00:00+08:00',
    }),
  );
  assert.equal(future.state, 'scheduled');
  assert.equal(f.store.changes.context(f.a.id, '月桂')[0].id, first.id);
  const conflict = accept(
    f,
    f.store.changes.propose(f.a.id, {
      ...f.input,
      kind: 'conflict',
      body: '两种截止日期尚有冲突，待用户核实，不采用任何一个。',
      effectiveAt: '2021-01-01T00:00:00Z',
    }),
  );
  assert.equal(f.store.changes.read(f.a.id, first.id).state, 'superseded');
  assert.equal(f.store.changes.context(f.a.id, '月桂').length, 1);
  assert.equal(f.store.changes.context(f.a.id, '月桂')[0].kind, 'conflict');
  assert.equal(f.store.context(f.a.id, '月桂').entries.length, 0);
  f.store.changes.review(f.a.id, conflict.id, { revision: conflict.revision, status: 'archived' });
  assert.equal(f.store.changes.context(f.a.id, '月桂')[0].id, first.id);
});

test('来源与角色严格校验，目标被修改后变更失效且不能沿用旧版本确认', (t) => {
  const f = fixture(t);
  const assistant = f.store.append(f.a.id, f.newer.id, {
    role: 'assistant',
    body: '这只是猜测',
    clientId: 'guess',
  });
  assert.throws(
    () =>
      f.store.changes.propose(f.a.id, {
        ...f.input,
        source: { kind: 'conversation', id: assistant.id, quote: assistant.body },
      }),
    /助手建议/,
  );
  assert.throws(
    () =>
      f.store.changes.propose(f.a.id, {
        ...f.input,
        source: { ...f.input.source, quote: '伪造内容' },
      }),
    /逐字/,
  );
  assert.throws(() => f.store.changes.propose(f.b.id, f.input), /此空间/);
  assert.throws(
    () => f.store.changes.propose(f.a.id, { ...f.input, effectiveAt: '2026-11-06' }),
    /时区/,
  );
  assert.throws(
    () => f.store.changes.propose(f.a.id, { ...f.input, effectiveAt: '2026-02-30T00:00:00Z' }),
    /有效日期/,
  );
  const c = accept(f, f.store.changes.propose(f.a.id, f.input));
  f.store.updateEntry(f.a.id, f.entry.id, { revision: 2, body: '虚构最新整理：日期仍待确认。' });
  assert.equal(f.store.changes.read(f.a.id, c.id).state, 'stale');
  assert.equal(f.store.changes.context(f.a.id, '月桂').length, 0);
  assert.equal(f.store.context(f.a.id, '月桂').entries.length, 1);
  assert.throws(
    () => f.store.changes.review(f.a.id, c.id, { revision: c.revision, status: 'accepted' }),
    /版本或状态/,
  );
});

test('原话和摘要项可以纠正；不影响同批其他角色摘要', (t) => {
  const f = fixture(t);
  const m = f.store.append(f.a.id, f.old.id, {
    role: 'assistant',
    body: '虚构月桂建议分批交付。',
    clientId: 'proposal',
  });
  const summary = f.store.summaries.create(
    f.a.id,
    f.old.id,
    f.store.summaries.nextBatch(f.a.id, f.old.id),
    [
      {
        role: 'user',
        title: '月桂旧日期',
        body: f.message.body,
        evidence: [{ messageId: f.message.id, quote: f.message.body }],
      },
      {
        role: 'assistant',
        title: '月桂交付建议',
        body: m.body,
        evidence: [{ messageId: m.id, quote: m.body }],
      },
    ],
  );
  f.store.summaries.review(f.a.id, f.old.id, summary.id, { revision: 1, status: 'accepted' });
  accept(
    f,
    f.store.changes.propose(f.a.id, {
      ...f.input,
      target: { kind: 'conversation', id: f.message.id, revision: 0 },
    }),
  );
  accept(
    f,
    f.store.changes.propose(f.a.id, {
      ...f.input,
      target: { kind: 'summary', id: summary.id, position: 0, revision: 2 },
    }),
  );
  assert.ok(
    !f.store.conversationContext(f.a.id, '月桂').excerpts.some((m) => m.id === f.message.id),
  );
  assert.equal(f.store.summaries.context(f.a.id, '月桂').length, 1);
  assert.equal(f.store.summaries.context(f.a.id, '月桂')[0].role, 'assistant');
  assert.ok(f.store.changes.candidates(f.a.id, '月桂').items.some((m) => m.id === f.message.id));
});

test('关闭和删除纠正来源时不重新启用旧结论，删除传播清理参考与搜索副本', async (t) => {
  const calls = [];
  const f = fixture(t, async (input) => {
    calls.push(input);
    return '周日，尚无交付形式决定。';
  });
  const c = accept(f, f.store.changes.propose(f.a.id, f.input));
  const current = f.store.createSession(f.a.id);
  const out = await f.service.reply(f.a.id, current.id, {
    body: '月桂截止日？',
    clientId: 'question',
  });
  assert.equal(out.changes[0].id, c.id);
  assert.equal(out.memoryIds.length, 0);
  assert.ok(calls[0].messages[0].content.includes('用户已审阅且当前生效'));
  f.store.updateSession(f.a.id, f.newer.id, { recallEnabled: false });
  const hidden = f.store.views.detail(f.a.id, f.entry.id).currentChange;
  assert.equal(hidden.body, '');
  assert.equal(hidden.quote, undefined);
  assert.equal(f.store.changes.context(f.a.id, '月桂').length, 0);
  assert.equal(f.store.context(f.a.id, '月桂').entries.length, 0);
  let trace = f.store.replyEvidence
    .read(f.a.id, current.id, out.message.id)
    .items.find((x) => x.kind === 'changes');
  assert.equal(trace.state, 'disabled');
  f.store.deleteSession(f.a.id, f.newer.id);
  assert.equal(f.store.changes.read(f.a.id, c.id).state, 'unavailable');
  assert.equal(f.store.changes.read(f.a.id, c.id).body, '');
  assert.equal(f.store.context(f.a.id, '月桂').entries.length, 0);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM memory_change_search').get().n, 0);
  trace = f.store.replyEvidence
    .read(f.a.id, current.id, out.message.id)
    .items.find((x) => x.kind === 'changes');
  assert.equal(trace.state, 'deleted');
  const unavailable = f.store.changes.read(f.a.id, c.id);
  f.store.changes.review(f.a.id, c.id, { revision: unavailable.revision, status: 'archived' });
  assert.equal(f.store.context(f.a.id, '月桂').entries.length, 1);
});

test('未确认候选的来源删除不隔离旧记忆；手动创建原文与候选原子提交、目录有界', (t) => {
  const f = fixture(t);
  f.store.changes.propose(f.a.id, f.input);
  f.store.deleteSession(f.a.id, f.newer.id);
  assert.equal(f.store.context(f.a.id, '月桂').entries.length, 1);
  const sources = f.store.views.sources(f.a.id).items.length;
  assert.throws(
    () =>
      f.store.changes.manual(f.a.id, {
        ...f.input,
        target: { kind: 'knowledge', id: f.entry.id, revision: 1 },
      }),
    /已更新/,
  );
  assert.equal(f.store.views.sources(f.a.id).items.length, sources);
  for (let i = 0; i < 22; i++) f.store.changes.manual(f.a.id, { ...f.input, title: `更改${i}` });
  const first = f.store.changes.list(f.a.id),
    next = f.store.changes.list(f.a.id, { before: first.nextBefore });
  assert.equal(first.items.length, 20);
  assert.equal(new Set([...first.items, ...next.items].map((i) => i.id)).size, 23);
  assert.ok(first.items.every((i) => i.body === undefined && i.quote === undefined));
});

test('新变更不会改写历史回答参考；旧依据显示已经变化', async (t) => {
  const f = fixture(t);
  const first = accept(f, f.store.changes.propose(f.a.id, f.input));
  const session = f.store.createSession(f.a.id);
  const reply = await f.service.reply(f.a.id, session.id, {
    body: '月桂截止日？',
    clientId: 'audit',
  });
  accept(
    f,
    f.store.changes.propose(f.a.id, {
      ...f.input,
      kind: 'conflict',
      body: '日期仍有冲突，需重新核实。',
      effectiveAt: '2021-01-01T00:00:00Z',
    }),
  );
  const item = f.store.replyEvidence
    .read(f.a.id, session.id, reply.message.id)
    .items.find((i) => i.kind === 'changes');
  assert.equal(item.state, 'changed');
  assert.equal(item.snapshot.id, first.id);
  assert.equal(item.snapshot.body, f.input.body);
});
