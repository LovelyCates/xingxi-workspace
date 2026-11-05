import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/store.mjs';
import { graphSubset } from '../src/graph-layout.js';

function setup(t) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const space = store.createSpace({ name: 'Performance fixtures' });
  return { store, space };
}
test('indexed memory follows edits, archive and namespace boundaries', (t) => {
  const { store, space } = setup(t);
  const other = store.createSpace({ name: 'Other' });
  const source = store.ingest(space.id, {
    title: 'Notes',
    body: '纸舟计划采用 SQLite，蓝鲸计划使用文件。',
  });
  let e = store.propose(space.id, {
    title: '纸舟计划',
    body: '纸舟计划采用 SQLite。',
    kind: 'decision',
    evidence: [{ sourceId: source.id, quote: '纸舟计划采用 SQLite' }],
  });
  e = store.updateEntry(space.id, e.id, { revision: e.revision, status: 'accepted' });
  assert.equal(store.context(space.id, '纸舟').entries[0].id, e.id);
  assert.equal(store.context(space.id, 'sqlite').entries[0].id, e.id);
  assert.equal(store.context(space.id, '纸').entries[0].id, e.id);
  assert.equal(store.context(other.id, '纸舟').entries.length, 0);
  e = store.updateEntry(space.id, e.id, {
    revision: e.revision,
    title: '蓝鲸计划',
    body: '蓝鲸计划使用文件。',
  });
  assert.equal(store.context(space.id, '纸舟').entries.length, 0);
  assert.equal(store.context(space.id, '蓝鲸').entries[0].id, e.id);
  store.updateEntry(space.id, e.id, { revision: e.revision, status: 'archived' });
  assert.equal(store.context(space.id, '蓝鲸').entries.length, 0);
});
test('space summaries omit raw sources and load originals explicitly', (t) => {
  const { store, space } = setup(t);
  const body = '不可省略的原文。'.repeat(5000);
  const source = store.ingest(space.id, { title: 'Large source', body });
  const summary = store.snapshot(space.id).sources[0];
  assert.equal(summary.body, undefined);
  assert.equal(summary.body_length, body.length);
  assert.equal(store.source(space.id, source.id).body, body);
});
test('long session pages are bounded, stable during appends and export every message', (t) => {
  const { store, space } = setup(t),
    session = store.createSession(space.id);
  for (let i = 0; i < 250; i++)
    store.append(space.id, session.id, {
      role: i % 2 ? 'assistant' : 'user',
      body: `message-${i}`,
      clientId: `client-${i}`,
    });
  const last = store.session(space.id, session.id);
  assert.equal(last.messages.length, 100);
  assert.equal(last.messages[0].body, 'message-150');
  assert.equal(last.hasMoreMessages, true);
  store.append(space.id, session.id, { role: 'user', body: 'new-message', clientId: 'new-client' });
  const middle = store.session(space.id, session.id, { before: last.nextBefore });
  assert.equal(middle.messages[0].body, 'message-50');
  assert.equal(middle.messages.at(-1).body, 'message-149');
  const first = store.session(space.id, session.id, { before: middle.nextBefore });
  assert.equal(first.messages.length, 50);
  assert.equal(first.hasMoreMessages, false);
  const source = store.sessionSource(space.id, session.id);
  assert.ok(source.body.includes('用户：message-0\n'));
  assert.ok(source.body.endsWith('用户：new-message'));
  const other = store.createSpace({ name: 'Other' });
  assert.throws(() => store.session(other.id, session.id, { before: last.nextBefore }), /此空间/);
});
test('large graph bounds rendering without inventing edges or dropping the searchable input', () => {
  const entries = Array.from({ length: 5000 }, (_, i) => ({ id: `n${i}`, created_at: String(i) }));
  const relations = entries.slice(1).map((e, i) => ({ id: `r${i}`, from_id: 'n0', to_id: e.id }));
  const subset = graphSubset(entries, relations);
  assert.equal(subset.nodes.length, 160);
  assert.equal(subset.nodes[0].id, 'n0');
  assert.ok(subset.edges.length <= 500);
  const ids = new Set(subset.nodes.map((n) => n.id));
  assert.ok(subset.edges.every((e) => ids.has(e.from_id) && ids.has(e.to_id)));
  assert.equal(entries.length, 5000);
  const filtered = graphSubset(
    entries.filter((e) => e.id === 'n4999'),
    relations,
  );
  assert.equal(filtered.nodes[0].id, 'n4999');
});
