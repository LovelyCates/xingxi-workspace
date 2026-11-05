import { performance } from 'node:perf_hooks';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, cpus } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { Store } from '../server/store.mjs';
import { graphSubset } from '../src/graph-layout.js';
const dir = mkdtempSync(join(tmpdir(), 'xingxi-benchmark-'));
const totals = { entries: 5000, sources: 50, sourceChars: 50000, messages: 10000, edges: 10000 };
const measure = (fn, n = 15) => {
  const times = [];
  for (let i = 0; i < n; i++) {
    const start = performance.now();
    fn();
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  return {
    medianMs: +times[Math.floor(n / 2)].toFixed(2),
    p95Ms: +times[Math.min(n - 1, Math.floor(n * 0.95))].toFixed(2),
  };
};
async function bench(StoreClass, name) {
  const store = new StoreClass(join(dir, `${name}.sqlite`));
  const space = store.createSpace({ name: 'Synthetic benchmark' }),
    s = store.createSession(space.id);
  const source = store.ingest(space.id, { title: 'Fixture', body: 'Synthetic evidence' });
  const stamp = new Date().toISOString(),
    entries = [];
  store.transaction(() => {
    const insert = store.db.prepare('INSERT INTO entries VALUES(?,?,?,?,?,?,?,?,?,?)');
    for (let i = 0; i < totals.entries; i++) {
      const e = {
        id: `e${i}`,
        space_id: space.id,
        title: `项目知识 ${i}`,
        body:
          `这是合成测试条目，包含项目设计与决策。${i === 3456 ? '青灯凭据测试标记' : ''} ` +
          '内容说明与证据整理。'.repeat(15),
        kind: 'concept',
        status: 'accepted',
        evidence: [{ sourceId: source.id, quote: 'Synthetic evidence' }],
        revision: 1,
        created_at: stamp,
        updated_at: stamp,
      };
      insert.run(
        e.id,
        e.space_id,
        e.title,
        e.body,
        e.kind,
        e.status,
        JSON.stringify(e.evidence),
        1,
        stamp,
        stamp,
      );
      if (store.indexEntry) store.indexEntry(e);
      entries.push(e);
    }
    for (let i = 1; i < totals.sources; i++)
      store.ingest(space.id, {
        title: `Source ${i}`,
        body: '资料片段。'.repeat(totals.sourceChars / 5),
      });
    const msg = store.db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?)');
    for (let i = 0; i < totals.messages; i++) {
      const body = '合成消息。'.repeat(25) + (i === 3456 ? '纸舟独特标记' : '');
      const role = i % 2 ? 'assistant' : 'user';
      const result = msg.run(`m${i}`, s.id, role, body, `c${i}`, stamp);
      store.conversations?.index(space.id, {
        sequence: Number(result.lastInsertRowid),
        role,
        body,
      });
    }
  });
  const query = store.context(space.id, '青灯凭据');
  if (!query.entries.some((e) => e.id === 'e3456'))
    throw new Error('Benchmark correctness check failed');
  const data = {
    name,
    search: measure(() => store.context(space.id, '青灯凭据')),
    spaceSnapshot: measure(() => JSON.stringify(store.snapshot(space.id)), 5),
    snapshotBytes: Buffer.byteLength(JSON.stringify(store.snapshot(space.id))),
    sessionRead: measure(() => store.session(space.id, s.id)),
    sessionResponseBytes: Buffer.byteLength(JSON.stringify(store.session(space.id, s.id))),
    append: measure(() =>
      store.append(space.id, s.id, {
        role: 'user',
        body: 'new',
        clientId: `new-${performance.now()}`,
      }),
    ),
  };
  const relations = Array.from({ length: totals.edges }, (_, i) => ({
    id: `r${i}`,
    from_id: `e${i % totals.entries}`,
    to_id: `e${(i * 7 + 1) % totals.entries}`,
  }));
  if (name === 'current') {
    data.graphPreparation = measure(() => graphSubset(entries, relations));
    const recall = store.conversationContext(space.id, '纸舟');
    if (recall.excerpts[0]?.id !== 'm3456') throw new Error('Conversation benchmark recall failed');
    data.conversationRecallSelective = measure(() => store.conversationContext(space.id, '纸舟'));
    data.conversationRecallCommon = measure(() => store.conversationContext(space.id, '合成消息'));
    data.conversationRecallRecent = measure(() => store.conversationContext(space.id, ''));
    data.conversationResponseBytes = Buffer.byteLength(JSON.stringify(recall));
  }
  store.close();
  return data;
}
try {
  const result = { node: process.version, cpu: cpus()[0].model, totals, results: [] };
  const ref = process.argv.find((x) => x.startsWith('--baseline='))?.slice(11);
  if (ref) {
    writeFileSync(
      join(dir, 'baseline.mjs'),
      execFileSync('git', ['show', `${ref}:server/store.mjs`]),
    );
    const { Store: OldStore } = await import(pathToFileURL(join(dir, 'baseline.mjs')).href);
    result.results.push(await bench(OldStore, 'baseline'));
  }
  result.results.push(await bench(Store, 'current'));
  console.log(JSON.stringify(result, null, 2));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
