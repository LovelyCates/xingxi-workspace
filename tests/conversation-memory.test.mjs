import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.mjs';
import { Service, deepseek } from '../server/service.mjs';

function fixture(t, provider) {
  const dir = mkdtempSync(join(tmpdir(), 'xingxi-recall-'));
  let store = new Store(join(dir, 'test.sqlite'));
  const service = new Service(store, dir, provider);
  const a = store.createSpace({ name: 'A', kind: 'companion' });
  const b = store.createSpace({ name: 'B' });
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
    dir,
    reopen() {
      store.close();
      store = new Store(join(dir, 'test.sqlite'));
      return store;
    },
  };
}
const append = (store, space, session, body, role = 'user') =>
  store.append(space.id, session.id, { body, role, clientId: crypto.randomUUID() });

test('会话原话自动索引；助手文本不升格为用户事实；跨空间隔离且保留否定', (t) => {
  const { store, a, b } = fixture(t);
  const s = store.createSession(a.id),
    other = store.createSession(b.id);
  const m = append(store, a, s, '这是虚构测试：我并不喜欢纸舟计划。');
  append(store, a, s, '用户喜欢蓝鲸，这是我猜的。', 'assistant');
  append(store, b, other, '蓝鲸保密计划');
  const result = store.conversationContext(a.id, '纸舟').excerpts;
  assert.equal(result[0].id, m.id);
  assert.equal(result[0].quote, m.body);
  assert.equal(result[0].status, 'conversation');
  assert.equal(store.conversationContext(a.id, '蓝鲸').excerpts.length, 0);
  assert.equal(store.conversationContext(b.id, '纸舟').excerpts.length, 0);
  assert.equal(store.context(a.id, '纸舟').entries.length, 0);
  assert.equal(store.conversationContext(a.id, '" OR * NOT (').excerpts.length, 0);
});

test('固定 MCP 绑定与本地索引跨重启保留，老数据库升级只回填一次', (t) => {
  const f = fixture(t),
    { store, a } = f;
  const s = store.openSession(a.id, { binding: 'desktop-companion' });
  append(store, a, s, '纸舟计划周五完成');
  assert.equal(store.openSession(a.id, { binding: 'desktop-companion' }).id, s.id);
  // Simulate the previous release: original messages exist, the new index does not.
  store.db.exec(
    "DROP TRIGGER message_search_delete; DROP TABLE conversation_search; DELETE FROM migrations WHERE name='conversation-index-v1';",
  );
  const next = f.reopen();
  assert.equal(next.conversationContext(a.id, '纸舟').excerpts.length, 1);
  assert.equal(next.openSession(a.id, { binding: 'desktop-companion' }).id, s.id);
  const again = f.reopen();
  assert.equal(again.conversationContext(a.id, '纸舟').excerpts.length, 1);
});

test('空间和会话开关即时退出召回；删除清理索引与绑定且不删已收录资料', (t) => {
  const { store, a, b } = fixture(t);
  const s = store.openSession(a.id, { binding: 'one' });
  append(store, a, s, '纸舟计划周五完成');
  const source = store.sessionSource(a.id, s.id);
  store.updateSession(a.id, s.id, { recallEnabled: false });
  assert.equal(store.conversationContext(a.id, '').excerpts.length, 0);
  assert.equal(store.session(a.id, s.id).messages.length, 1);
  store.updateSession(a.id, s.id, { recallEnabled: true });
  store.updateSpace(a.id, { recallEnabled: false });
  assert.equal(store.conversationContext(a.id, '纸舟').enabled, false);
  assert.equal(store.conversationContext(a.id, '纸舟').excerpts.length, 0);
  store.updateSpace(a.id, { recallEnabled: true });
  assert.equal(store.conversationContext(a.id, '纸舟').excerpts.length, 1);
  assert.throws(() => store.deleteSession(b.id, s.id), /此空间/);
  store.deleteSession(a.id, s.id);
  assert.equal(store.conversationContext(a.id, '').excerpts.length, 0);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM conversation_search').get().n, 0);
  assert.notEqual(store.openSession(a.id, { binding: 'one' }).id, s.id);
  assert.ok(store.source(a.id, source.id).body.includes('纸舟'));
});

test('新会话与超过窗口的同会话可引用原话，模型上下文有界且包含当前纠正', async (t) => {
  const calls = [];
  const { store, service, a, b } = fixture(t, async (input) => {
    calls.push(input);
    return '明白，按最新情况来。';
  });
  service.saveSettings({ key: 'sk-test-not-real' });
  const s = store.createSession(a.id),
    other = store.createSession(b.id);
  append(store, a, s, '虚构测试：纸舟截止日期是周五。');
  for (let i = 0; i < 60; i++) append(store, a, s, `一般闲聊 ${i}`);
  append(store, b, other, '不属于本空间的秘密');
  const out = await service.reply(a.id, s.id, { body: '纠正：纸舟延期到周日', clientId: 'turn' });
  assert.ok(out.conversationMemory.some((m) => m.quote.includes('周五')));
  assert.ok(calls[0].messages.at(-1).content.includes('周日'));
  assert.ok(!JSON.stringify(calls[0]).includes('不属于本空间的秘密'));
  assert.ok(calls[0].messages.length <= 21);
  const fresh = store.createSession(a.id);
  await service.reply(a.id, fresh.id, { body: '纸舟截止日期？', clientId: 'new' });
  assert.ok(calls[1].messages[0].content.includes('周日'));
  const count = store.session(a.id, fresh.id).messages.length;
  await service.reply(a.id, fresh.id, { body: '纸舟截止日期？', clientId: 'new' });
  assert.equal(calls.length, 2);
  assert.equal(store.session(a.id, fresh.id).messages.length, count);
  store.updateSpace(a.id, { recallEnabled: false });
  const disabled = store.createSession(a.id);
  const result = await service.reply(a.id, disabled.id, { body: '你好', clientId: 'disabled' });
  assert.equal(result.conversationMemory.length, 0);
  assert.ok(!calls[2].messages[0].content.includes('周五'));
});

test('追加与索引原子提交，重复请求不重复索引；分页会话列表有界', (t) => {
  const { store, a } = fixture(t);
  const s = store.createSession(a.id);
  const input = { role: 'user', body: '原子测试', clientId: 'same' };
  const original = store.conversations.index;
  store.conversations.index = () => {
    throw new Error('disk error');
  };
  assert.throws(() => store.append(a.id, s.id, input), /disk error/);
  assert.equal(store.session(a.id, s.id).messages.length, 0);
  store.conversations.index = original;
  store.append(a.id, s.id, input);
  store.append(a.id, s.id, input);
  assert.equal(store.conversationContext(a.id, '').excerpts.length, 1);
  for (let i = 0; i < 105; i++) store.createSession(a.id, `Session ${i}`);
  const first = store.sessionList(a.id),
    next = store.sessionList(a.id, { before: first.nextBefore });
  assert.equal(first.sessions.length, 50);
  assert.equal(first.hasMore, true);
  assert.equal(new Set([...first.sessions, ...next.sessions].map((x) => x.id)).size, 100);
});

test('正在生成的会话不可删除，模型失败后可删除', async (t) => {
  let finish;
  const { store, service, a } = fixture(
    t,
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  service.saveSettings({ key: 'sk-test-not-real' });
  const s = store.createSession(a.id);
  const pending = service.reply(a.id, s.id, { body: '你好', clientId: 'one' });
  assert.throws(() => service.deleteSession(a.id, s.id), /正在回复/);
  finish('你好');
  await pending;
  assert.equal(service.deleteSession(a.id, s.id).deleted, true);
});

test('模型传输固定 DeepSeek 官方接口并禁止重定向，错误不回显凭证', async (t) => {
  const key = 'sk-test-never-network';
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    calls++;
    assert.equal(url, 'https://api.deepseek.com/chat/completions');
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.Authorization, `Bearer ${key}`);
    throw new Error(`redirect or network failure ${key}`);
  });
  await assert.rejects(
    deepseek({ key, model: 'test', messages: [] }),
    (error) => !error.message.includes(key) && /网络/.test(error.message),
  );
  assert.equal(calls, 1);
});
