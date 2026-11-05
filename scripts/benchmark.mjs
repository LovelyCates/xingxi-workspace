import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { backupTask } from '../server/backups.mjs';
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
  const relations = Array.from({ length: totals.edges }, (_, i) => ({
    id: `r${i}`,
    from_id: `e${i % totals.entries}`,
    to_id: `e${(i * 7 + 1) % totals.entries}`,
  }));
  store.transaction(() => {
    const insert = store.db.prepare('INSERT INTO relations VALUES(?,?,?,?,?)');
    for (const [i, r] of relations.entries())
      insert.run(
        r.id,
        space.id,
        r.from_id,
        r.to_id === r.from_id ? `e${(i + 2) % totals.entries}` : r.to_id,
        `related-${i}`,
      );
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
  if (name === 'current') {
    data.graphPreparation = measure(() => graphSubset(entries, relations));
    data.pageViews = {};
    for (const view of ['graph', 'book', 'timeline', 'workshop', 'chat']) {
      const result = store.views.read(space.id, { view });
      data.pageViews[view] = {
        ...measure(() => JSON.stringify(store.views.read(space.id, { view }))),
        bytes: Buffer.byteLength(JSON.stringify(result)),
      };
    }
    if (store.views.entries(space.id, { q: '青灯凭据' }).items[0]?.id !== 'e3456')
      throw new Error('Catalog recall failed');
    const recall = store.conversationContext(space.id, '纸舟');
    if (recall.excerpts[0]?.id !== 'm3456') throw new Error('Conversation benchmark recall failed');
    data.conversationRecallSelective = measure(() => store.conversationContext(space.id, '纸舟'));
    data.conversationRecallCommon = measure(() => store.conversationContext(space.id, '合成消息'));
    data.conversationRecallRecent = measure(() => store.conversationContext(space.id, ''));
    data.conversationResponseBytes = Buffer.byteLength(JSON.stringify(recall));
    if (process.argv.includes('--backup')) {
      const destination = join(dir, 'benchmark-backup');
      const delay = monitorEventLoopDelay({ resolution: 10 });
      const reads = [];
      const timer = setInterval(() => {
        const start = performance.now();
        store.session(space.id, s.id, { limit: 20 });
        reads.push(performance.now() - start);
      }, 10);
      delay.enable();
      const phases = {};
      let backupResult;
      try {
        for (const operation of ['create', 'verify', 'restore']) {
          const start = performance.now();
          const result = await backupTask({
            operation,
            source: operation === 'create' ? join(dir, `${name}.sqlite`) : destination,
            destination:
              operation === 'create'
                ? destination
                : operation === 'restore'
                  ? join(dir, 'benchmark-restored')
                  : undefined,
          });
          phases[operation] = +(performance.now() - start).toFixed(2);
          if (operation === 'create') backupResult = result;
        }
      } finally {
        clearInterval(timer);
        delay.disable();
      }
      reads.sort((a, b) => a - b);
      data.backup = {
        phaseWallMs: phases,
        bytes: backupResult.manifest.bytes,
        concurrentReadSamples: reads.length,
        concurrentReadMedianMs: +(reads[Math.floor(reads.length / 2)] || 0).toFixed(2),
        eventLoopDelayMaxMs: +(delay.max / 1e6).toFixed(2),
        note: 'Single run; background worker copy/hash/integrity checks, while the main thread reads 20 messages every 10ms. Not browser or network latency.',
      };
    }
    if (process.argv.includes('--evidence')) {
      const pagesBefore = store.db.prepare('PRAGMA page_count').get().page_count;
      const pageSize = store.db.prepare('PRAGMA page_size').get().page_size;
      const knowledge = entries.slice(0, 8).map((e) => ({
        id: e.id,
        revision: e.revision,
        title: e.title,
        body: e.body.slice(0, 1600),
        sources: [{ sourceId: source.id, quote: 'Synthetic evidence', origin: 'benchmark' }],
      }));
      const conversation = Array.from({ length: 8 }, (_, i) => ({
        id: `m${i * 2}`,
        session_id: s.id,
        session_title: 'Synthetic benchmark',
        quote: '合成消息。'.repeat(25),
        role: 'user',
        created_at: stamp,
      }));
      const recent = Array.from({ length: 20 }, (_, i) => ({
        id: `m${i}`,
        role: i % 2 ? 'assistant' : 'user',
        created_at: stamp,
      }));
      const input = { model: 'benchmark-no-network', knowledge, conversation, recent };
      store.transaction(() => {
        for (let i = 1; i < totals.messages; i += 2)
          store.replyEvidence.save(space.id, s.id, `m${i}`, input);
      });
      const readEvidence = () => store.replyEvidence.read(space.id, s.id, 'm9999');
      const sample = readEvidence();
      if (sample.items.length !== 36) throw new Error('Evidence benchmark correctness failed');
      data.replyEvidence = {
        records: totals.messages / 2,
        itemsPerRecord: 36,
        databasePageGrowthBytes:
          (store.db.prepare('PRAGMA page_count').get().page_count - pagesBefore) * pageSize,
        readAndSerialize: measure(() => JSON.stringify(readEvidence())),
        bytes: Buffer.byteLength(JSON.stringify(sample)),
        saveWithReply: measure(() =>
          store.transaction(() => {
            const reply = store.append(space.id, s.id, {
              role: 'assistant',
              body: '合成回复',
              clientId: `audit-${performance.now()}`,
            });
            store.replyEvidence.save(space.id, s.id, reply.id, input);
          }),
        ),
      };
    }
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
