import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../server/store.mjs';

function fixture(t, count = 0) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const a = store.createSpace({ name: 'Page tests' }),
    b = store.createSpace({ name: 'Other' });
  const source = store.ingest(a.id, { title: 'Evidence', body: '合成证据' });
  const entries = [];
  store.transaction(() => {
    for (let i = 0; i < count; i++) {
      const e = store.propose(a.id, {
        title: `Knowledge ${i}`,
        body: '普通正文。'.repeat(80) + (i === 0 ? '末尾月桂独特标记' : ''),
        evidence: [{ sourceId: source.id, quote: '合成证据' }],
      });
      entries.push(store.updateEntry(a.id, e.id, { revision: 1, status: 'accepted' }));
    }
  });
  return { store, a, b, source, entries };
}

test('页面只读取有界摘要，正文和证据按点击读取，统计来自整个空间', (t) => {
  const { store, a, source, entries } = fixture(t, 221);
  for (let i = 0; i < 65; i++) {
    store.ingest(a.id, { title: `Source ${i}`, body: '资料'.repeat(3000) });
    store.createSession(a.id, `Session ${i}`);
  }
  store.snapshot = () => {
    throw new Error('legacy full snapshot must not be used');
  };
  const book = store.views.read(a.id, { view: 'book' });
  assert.equal(book.entries.length, 60);
  assert.equal(book.counts.accepted, 221);
  assert.equal(book.counts.sources, 66);
  assert.equal(book.pages.entries.hasMore, true);
  assert.ok(
    book.entries.every(
      (e) =>
        e.preview.length <= 240 &&
        e.body === undefined &&
        e.evidence === undefined &&
        e.evidence_count === 1,
    ),
  );
  assert.equal(book.sources.length, 0);
  assert.equal(book.sessions.length, 0);
  assert.equal(store.views.read(a.id, { view: 'graph' }).entries.length, 160);
  const workshop = store.views.read(a.id, { view: 'workshop' });
  assert.equal(workshop.sources.length, 50);
  assert.equal(workshop.entries.length, 0);
  assert.ok(workshop.sources.every((s) => s.body === undefined));
  const chat = store.views.read(a.id, { view: 'chat' });
  assert.equal(chat.sessions.length, 50);
  assert.equal(chat.entries.length, 0);
  assert.equal(chat.counts.sessions, 65);
  assert.ok(Buffer.byteLength(JSON.stringify(chat)) < 16000);
  const detail = store.views.detail(a.id, entries[0].id);
  assert.ok(detail.body.endsWith('末尾月桂独特标记'));
  assert.equal(detail.sourceSummaries[0].title, source.title);
  assert.equal(detail.sourceSummaries[0].body, undefined);
});

test('同时间戳知识分页不遗漏，搜索覆盖末页与摘要外正文并遵守状态和空间', (t) => {
  const { store, a, b, entries } = fixture(t, 181);
  store.db
    .prepare('UPDATE entries SET updated_at=? WHERE space_id=?')
    .run('2026-01-01T00:00:00.000Z', a.id);
  const ids = [];
  let after;
  do {
    const p = store.views.entries(a.id, { after, limit: 30 });
    ids.push(...p.items.map((e) => e.id));
    after = p.nextCursor;
  } while (after);
  assert.equal(ids.length, 181);
  assert.equal(new Set(ids).size, 181);
  assert.equal(store.views.entries(a.id, { q: '月桂独特' }).items[0].id, entries[0].id);
  assert.equal(store.views.entries(b.id, { q: '月桂独特' }).items.length, 0);
  let e = store.updateEntry(a.id, entries[0].id, { revision: 2, status: 'archived' });
  assert.equal(store.views.entries(a.id, { q: '月桂独特' }).items.length, 0);
  assert.equal(store.views.entries(a.id, { q: '月桂独特', filter: 'archived' }).items[0].id, e.id);
  e = store.updateEntry(a.id, e.id, {
    revision: e.revision,
    status: 'pending',
    body: '改用青叶标记',
  });
  assert.equal(store.views.entries(a.id, { q: '月桂独特', filter: 'pending' }).items.length, 0);
  assert.equal(store.views.entries(a.id, { q: '青叶标记', filter: 'pending' }).items[0].id, e.id);
  assert.throws(() => store.views.entries(a.id, { after: 'malformed' }), /游标/);
  assert.throws(() => store.views.entries(a.id, { filter: 'sql injection' }), /筛选/);
  assert.equal(store.views.entries(a.id, { q: '" OR * (' }).items.length, 0);
});

test('来源和星历使用复合游标，跨类型同时间事件全部可达且没有原文负载', (t) => {
  const { store, a } = fixture(t, 61);
  for (let i = 0; i < 70; i++)
    store.ingest(a.id, { title: `Old source ${i}`, body: '原始正文'.repeat(1000) });
  store.db
    .prepare('UPDATE entries SET updated_at=? WHERE space_id=?')
    .run('2026-01-01T00:00:00.000Z', a.id);
  store.db
    .prepare('UPDATE sources SET created_at=? WHERE space_id=?')
    .run('2026-01-01T00:00:00.000Z', a.id);
  const ids = [];
  let after;
  do {
    const p = store.views.timeline(a.id, { after, limit: 15 });
    ids.push(...p.items.map((e) => e.id));
    assert.ok(p.items.every((e) => e.body === undefined));
    after = p.nextCursor;
  } while (after);
  assert.equal(ids.length, 132);
  assert.equal(new Set(ids).size, 132);
  assert.equal(store.views.sources(a.id, { q: 'Old source 69' }).items.length, 1);
  const first = store.views.sources(a.id);
  store.ingest(a.id, { title: 'New', body: '新插入' });
  const second = store.views.sources(a.id, { after: first.nextCursor });
  assert.equal(new Set([...first.items, ...second.items].map((s) => s.id)).size, 71);
});

test('图谱与邻居有上限，页外关系目标可检索，详情拒绝跨空间访问', (t) => {
  const { store, a, b, entries } = fixture(t, 165);
  for (const e of entries.slice(1))
    store.relate(a.id, { fromId: entries[0].id, toId: e.id, label: '支持' });
  const graph = store.views.read(a.id, { view: 'graph' });
  const ids = new Set(graph.entries.map((e) => e.id));
  assert.ok(graph.relations.length <= 500);
  assert.ok(graph.relations.every((r) => ids.has(r.from_id) && ids.has(r.to_id)));
  const first = store.views.neighbors(a.id, entries[0].id);
  assert.equal(first.items.length, 50);
  assert.equal(first.hasMore, true);
  const next = store.views.neighbors(a.id, entries[0].id, { after: first.nextCursor });
  assert.equal(new Set([...first.items, ...next.items].map((e) => e.id)).size, 100);
  assert.ok(first.items.every((r) => r.neighbor_title.startsWith('Knowledge')));
  assert.throws(() => store.views.detail(b.id, entries[0].id), /此空间/);
});

test('目录索引更新失败时正文与版本原子回滚，嵌套事务不会破坏外层事务', (t) => {
  const { store, a, source, entries } = fixture(t, 1);
  const original = store.views.index;
  store.views.index = () => {
    throw new Error('index failure');
  };
  assert.throws(
    () =>
      store.propose(a.id, {
        title: 'New',
        body: 'New',
        evidence: [{ sourceId: source.id, quote: '合成证据' }],
      }),
    /index failure/,
  );
  assert.equal(store.views.counts(a.id).pending, 0);
  assert.throws(
    () => store.updateEntry(a.id, entries[0].id, { revision: 2, body: 'changed' }),
    /index failure/,
  );
  assert.equal(store.entry(a.id, entries[0].id).revision, 2);
  assert.equal(store.history(a.id, entries[0].id).length, 1);
  store.views.index = original;
  assert.throws(
    () =>
      store.transaction(() => {
        store.propose(a.id, {
          title: 'Outer',
          body: 'Outer',
          evidence: [{ sourceId: source.id, quote: '合成证据' }],
        });
        throw new Error('outer rollback');
      }),
    /outer rollback/,
  );
  assert.equal(store.views.counts(a.id).pending, 0);
});

test('已有知识升级一次回填目录索引，重启后全文搜索仍正确', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'xingxi-catalog-'));
  let store = new Store(join(dir, 'test.sqlite'));
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const a = store.createSpace({ name: 'Migration' }),
    source = store.ingest(a.id, { title: 'Evidence', body: '旧资料' });
  const e = store.propose(a.id, {
    title: '旧条目',
    body: '目录升级月桂标记',
    evidence: [{ sourceId: source.id, quote: '旧资料' }],
  });
  store.db.exec(
    "DROP TRIGGER catalog_delete; DROP TABLE catalog_search; DROP TABLE catalog_docs; DELETE FROM migrations WHERE name='catalog-search-v1';",
  );
  store.close();
  store = new Store(join(dir, 'test.sqlite'));
  assert.equal(store.views.entries(a.id, { q: '月桂', filter: 'pending' }).items[0].id, e.id);
  store.close();
  store = new Store(join(dir, 'test.sqlite'));
  assert.equal(store.views.entries(a.id, { q: '月桂', filter: 'pending' }).items.length, 1);
  store.db.prepare('UPDATE sources SET body=? WHERE id=?').run('旧资料🌙', source.id);
  assert.equal(store.views.sources(a.id).items[0].body_length, 4);
  store.db.exec(
    "DROP TRIGGER source_size_insert; DROP TRIGGER source_size_update; DROP TABLE source_metrics; DELETE FROM migrations WHERE name='source-sizes-v1';",
  );
  store.close();
  store = new Store(join(dir, 'test.sqlite'));
  assert.equal(store.views.sources(a.id).items[0].body_length, 4);
});
