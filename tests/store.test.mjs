import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.mjs';
import { Service } from '../server/service.mjs';

function fixture(t, provider) {
  const dir = mkdtempSync(join(tmpdir(), 'xingxi-test-'));
  const store = new Store(join(dir, 'test.sqlite'));
  const service = new Service(store, dir, provider);
  t.after(async () => {
    await service.queue;
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const a = store.createSpace({ name: '项目 A' }),
    b = store.createSpace({ name: '私人空间', kind: 'companion' });
  const source = store.ingest(a.id, {
    title: '会议原文',
    body: '项目决定先在本地运行。用户希望回复简洁。',
  });
  return { dir, store, service, a, b, source };
}
const candidate = (source) => ({
  title: '本地优先',
  body: '项目首版在本地运行。',
  kind: 'decision',
  evidence: [{ sourceId: source.id, quote: '项目决定先在本地运行。' }],
});
test('来源必须逐字可核对，待确认不进入检索，空间之间不可串读或关联', (t) => {
  const { store, a, b, source } = fixture(t);
  assert.throws(() => store.propose(b.id, candidate(source)), /此空间内没有该来源/);
  assert.throws(
    () =>
      store.propose(a.id, {
        ...candidate(source),
        evidence: [{ sourceId: source.id, quote: '无中生有' }],
      }),
    /原文/,
  );
  const e = store.propose(a.id, candidate(source));
  assert.equal(store.context(a.id, '本地').entries.length, 0);
  store.updateEntry(a.id, e.id, { revision: 1, status: 'accepted' });
  assert.equal(store.context(a.id, '本地运行').entries[0].id, e.id);
  assert.equal(store.context(b.id, '本地').entries.length, 0);
  assert.throws(() => store.entry(b.id, e.id), /此空间/);
  assert.throws(() => store.relate(b.id, { fromId: e.id, toId: e.id, label: '关联' }), /此空间/);
});
test('修订有历史且拒绝并发覆盖，归档退出检索', (t) => {
  const { store, a, source } = fixture(t);
  const e = store.propose(a.id, candidate(source));
  const updated = store.updateEntry(a.id, e.id, {
    revision: 1,
    status: 'accepted',
    body: '先完成本机运行。',
  });
  assert.equal(updated.revision, 2);
  assert.equal(store.history(a.id, e.id)[0].snapshot.body, e.body);
  assert.throws(() => store.updateEntry(a.id, e.id, { revision: 1, body: '旧写入' }), /已更新/);
  assert.equal(store.entry(a.id, e.id).body, '先完成本机运行。');
  store.updateEntry(a.id, e.id, { revision: 2, status: 'archived' });
  assert.equal(store.context(a.id, '').entries.length, 0);
});
test('持久会话跨重启保留，消息标识幂等且不可重用于不同内容', (t) => {
  const { store, a, b, dir } = fixture(t);
  const s = store.createSession(a.id, '继续上次的话题');
  const input = { role: 'user', body: '明天再聊', clientId: 'one' };
  const first = store.append(a.id, s.id, input);
  assert.equal(store.append(a.id, s.id, input).id, first.id);
  assert.throws(() => store.append(a.id, s.id, { ...input, body: '不同的消息' }), /其他内容/);
  assert.throws(() => store.session(b.id, s.id), /此空间/);
  const reopened = new Store(join(dir, 'test.sqlite'));
  assert.equal(reopened.session(a.id, s.id).messages.length, 1);
  reopened.close();
});
test('提炼逐条验证摘录，失败回滚所有候选，成功仍需确认', async (t) => {
  let valid = false;
  const { store, service, a, source } = fixture(t, async () =>
    JSON.stringify({
      entries: [
        {
          title: '本地优先',
          body: '先本地运行',
          kind: 'decision',
          quote: '项目决定先在本地运行。',
        },
        ...(valid
          ? []
          : [{ title: '错误条目', body: '无依据', kind: 'concept', quote: '不存在的原文' }]),
      ],
    }),
  );
  service.saveSettings({ key: 'sk-test-not-real' });
  let job = service.compile(a.id, source.id);
  await service.queue;
  assert.equal(service.job(a.id, job.id).status, 'failed');
  assert.equal(store.snapshot(a.id).entries.length, 0);
  valid = true;
  job = service.compile(a.id, source.id);
  await service.queue;
  assert.equal(service.job(a.id, job.id).status, 'done');
  assert.equal(store.snapshot(a.id).entries[0].status, 'pending');
  assert.equal(store.context(a.id, '').entries.length, 0);
});
test('对话仅带本空间已确认记忆和最近消息；重试幂等；Key 不回显', async (t) => {
  const calls = [];
  const { store, service, a, b, source, dir } = fixture(t, async (input) => {
    calls.push(input);
    return '我们接着聊本地运行。';
  });
  const key = 'sk-test-secret';
  service.saveSettings({ key });
  assert.equal(service.settings().configured, true);
  assert.ok(!JSON.stringify(service.settings()).includes(key));
  assert.equal(statSync(join(dir, 'secrets.json')).mode & 0o777, 0o600);
  const e = store.propose(a.id, candidate(source));
  store.updateEntry(a.id, e.id, { revision: 1, status: 'accepted' });
  const secret = store.ingest(b.id, { title: '秘密', body: '独立空间暗号蓝鲸。' });
  const ep = store.propose(b.id, {
    title: '暗号',
    body: secret.body,
    kind: 'preference',
    evidence: [{ sourceId: secret.id, quote: secret.body }],
  });
  store.updateEntry(b.id, ep.id, { revision: 1, status: 'accepted' });
  const session = store.createSession(a.id);
  const payload = { body: '本地如何运行？', clientId: 'turn-1' };
  await service.reply(a.id, session.id, payload);
  await service.reply(a.id, session.id, payload);
  assert.equal(calls.length, 1);
  assert.equal(store.session(a.id, session.id).messages.length, 2);
  assert.ok(calls[0].messages[0].content.includes('项目首版在本地运行'));
  assert.ok(!JSON.stringify(calls).includes('蓝鲸'));
  await assert.rejects(
    service.reply(a.id, session.id, { ...payload, body: '重用标识' }),
    /其他内容/,
  );
});
test('没 Key 不写入虚假回答；模型失败可以复用原消息重试', async (t) => {
  let fail = true;
  const { store, service, a } = fixture(t, async () => {
    if (fail) throw new Error('provider unavailable');
    return '继续。';
  });
  const s = store.createSession(a.id),
    p = { body: '你好', clientId: 'one' };
  await assert.rejects(service.reply(a.id, s.id, p), /还没配置/);
  assert.equal(store.session(a.id, s.id).messages.length, 0);
  service.saveSettings({ key: 'sk-test' });
  await assert.rejects(service.reply(a.id, s.id, p));
  assert.equal(store.session(a.id, s.id).messages.length, 1);
  fail = false;
  await service.reply(a.id, s.id, p);
  assert.equal(store.session(a.id, s.id).messages.length, 2);
});
test('Markdown 导出包含来源与已确认记忆，不含候选', (t) => {
  const { store, a, source } = fixture(t);
  const e = store.propose(a.id, candidate(source));
  store.updateEntry(a.id, e.id, { revision: 1, status: 'accepted' });
  store.propose(a.id, { ...candidate(source), title: '未确认秘密' });
  const md = store.exportMarkdown(a.id);
  assert.ok(md.includes('会议原文'));
  assert.ok(md.includes(source.id));
  assert.ok(!md.includes('未确认秘密'));
});
