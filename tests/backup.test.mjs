import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
  existsSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  statSync,
  copyFileSync,
  mkdirSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../server/store.mjs';
import { Service } from '../server/service.mjs';
import { backupTask, Backups } from '../server/backups.mjs';
import { verifyBackup, restoreBackup } from '../server/backup-core.mjs';

const createBackup = (source, destination) =>
  backupTask({ operation: 'create', source, destination });
const dropChanges = (db) =>
  db.exec(`DROP VIEW memory_change_state;
  DROP TRIGGER evidence_change_delete; DROP TRIGGER evidence_change_unavailable;
  DROP TRIGGER change_message_deleted; DROP TRIGGER change_source_deleted; DROP TRIGGER change_entry_deleted; DROP TRIGGER change_summary_deleted;
  DROP TABLE memory_change_events; DROP TABLE memory_changes; DROP TABLE memory_change_search;`);

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'xingxi-backup-'));
  const store = new Store(join(dir, 'xingxi.sqlite'));
  const service = new Service(store, dir, async () => '这是虚构验收回复。');
  service.saveSettings({ key: 'sk-private-backup-fixture' });
  const space = store.createSpace({ name: '备份测试' });
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, store, service, space };
}

test('在线 WAL 备份恢复保留消息序号、MCP 绑定、索引、版本及回答参考，排除凭证文件', async (t) => {
  const { dir, store, service, space } = fixture(t);
  const deleted = store.createSession(space.id);
  store.append(space.id, deleted.id, { role: 'user', body: '删除以产生行号空洞', clientId: 'gap' });
  const prior = store.openSession(space.id, { binding: 'stable' });
  const original = store.append(space.id, prior.id, {
    role: 'user',
    body: '虚构的月桂标记。',
    clientId: 'original',
  });
  store.deleteSession(space.id, deleted.id);
  const source = store.ingest(space.id, { title: '资料', body: '虚构月桂资料' });
  let entry = store.propose(space.id, {
    title: '月桂',
    body: source.body,
    kind: 'concept',
    evidence: [{ sourceId: source.id, quote: source.body }],
  });
  entry = store.updateEntry(space.id, entry.id, { revision: 1, status: 'accepted' });
  const conversation = store.createSession(space.id, '回答验收');
  const answer = await service.reply(space.id, conversation.id, {
    body: '月桂是什么？',
    clientId: 'answer',
  });
  const beforeSession = store.session(space.id, prior.id);
  const beforeTrace = store.replyEvidence.read(space.id, conversation.id, answer.message.id);
  assert.ok(existsSync(join(dir, 'xingxi.sqlite-wal')));
  store.db.exec('BEGIN IMMEDIATE');
  store.db
    .prepare('INSERT INTO messages VALUES(?,?,?,?,?,?)')
    .run(
      'uncommitted',
      prior.id,
      'assistant',
      '未提交内容',
      'uncommitted',
      new Date().toISOString(),
    );
  const backupDir = join(dir, 'portable');
  try {
    await backupTask({
      operation: 'create',
      source: join(dir, 'xingxi.sqlite'),
      destination: backupDir,
    });
  } finally {
    store.db.exec('ROLLBACK');
  }
  assert.deepEqual(readdirSync(backupDir).sort(), ['manifest.json', 'xingxi.sqlite']);
  assert.ok(
    !readFileSync(join(backupDir, 'xingxi.sqlite')).includes(
      Buffer.from('sk-private-backup-fixture'),
    ),
  );
  assert.ok(
    !readFileSync(join(backupDir, 'xingxi.sqlite')).includes(
      readFileSync(join(dir, 'access-token')),
    ),
  );
  if (process.platform !== 'win32') {
    assert.equal(statSync(backupDir).mode & 0o777, 0o700);
    assert.equal(statSync(join(backupDir, 'xingxi.sqlite')).mode & 0o777, 0o600);
  }
  const checked = await verifyBackup(backupDir);
  assert.equal(checked.verified, true);
  const target = join(dir, 'recovered');
  await backupTask({ operation: 'restore', source: backupDir, destination: target });
  assert.deepEqual(readdirSync(target), ['xingxi.sqlite']);
  const restored = new Store(join(target, 'xingxi.sqlite'));
  try {
    assert.deepEqual(restored.session(space.id, prior.id), beforeSession);
    assert.equal(restored.openSession(space.id, { binding: 'stable' }).id, prior.id);
    assert.equal(
      restored.conversationContext(space.id, '月桂').excerpts.find((m) => m.id === original.id)
        .quote,
      original.body,
    );
    assert.equal(restored.views.entries(space.id, { q: '月桂' }).items[0].id, entry.id);
    assert.equal(restored.history(space.id, entry.id).length, 1);
    assert.deepEqual(
      restored.replyEvidence.read(space.id, conversation.id, answer.message.id),
      beforeTrace,
    );
    const recoveredService = new Service(restored, target);
    assert.equal(recoveredService.settings().configured, false);
    assert.notEqual(recoveredService.token, service.token);
    assert.equal(
      restored.db.prepare("SELECT count(*) AS n FROM messages WHERE id='uncommitted'").get().n,
      0,
    );
  } finally {
    restored.close();
  }
});

test('拒绝覆盖现有目录，损坏和篡改的备份不能发布为恢复实例', async (t) => {
  const { dir, store } = fixture(t);
  const backupDir = join(dir, 'portable');
  await createBackup(join(dir, 'xingxi.sqlite'), backupDir);
  const existing = join(dir, 'existing');
  mkdirSync(existing);
  writeFileSync(join(existing, 'keep'), 'keep');
  await assert.rejects(restoreBackup(backupDir, existing), { code: 'EEXIST' });
  assert.equal(readFileSync(join(existing, 'keep'), 'utf8'), 'keep');
  await assert.rejects(createBackup(join(dir, 'xingxi.sqlite'), backupDir), /目标已存在/);
  const bytes = readFileSync(join(backupDir, 'xingxi.sqlite'));
  bytes[100] ^= 1;
  writeFileSync(join(backupDir, 'xingxi.sqlite'), bytes);
  await assert.rejects(verifyBackup(backupDir), /校验和/);
  await assert.rejects(restoreBackup(backupDir, join(dir, 'bad-copy')), /校验和/);
  assert.equal(existsSync(join(dir, 'bad-copy')), false);
  assert.equal(store.spaces().length, 1);
});

test('校验和不能授权未知数据库结构；不接受额外触发器或符号链接', async (t) => {
  const { dir } = fixture(t);
  const backupDir = join(dir, 'portable');
  await createBackup(join(dir, 'xingxi.sqlite'), backupDir);
  const dbPath = join(backupDir, 'xingxi.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec('CREATE TRIGGER unexpected AFTER INSERT ON sources BEGIN DELETE FROM messages; END;');
  db.close();
  const manifestPath = join(backupDir, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath));
  manifest.bytes = statSync(dbPath).size;
  manifest.sha256 = createHash('sha256').update(readFileSync(dbPath)).digest('hex');
  writeFileSync(manifestPath, JSON.stringify(manifest));
  await assert.rejects(restoreBackup(backupDir, join(dir, 'unsafe')), /结构/);
  assert.equal(existsSync(join(dir, 'unsafe')), false);
  if (process.platform !== 'win32') {
    const linked = join(dir, 'linked');
    mkdirSync(linked);
    copyFileSync(manifestPath, join(linked, 'manifest.json'));
    symlinkSync(dbPath, join(linked, 'xingxi.sqlite'));
    await assert.rejects(verifyBackup(linked), /符号链接/);
  }
});

test('备份控制器单任务运行、忽略未完成目录，并将恢复写到独立目录', async (t) => {
  const { dir } = fixture(t);
  const manager = new Backups(dir);
  const job = await manager.start('create');
  assert.equal(job.status, 'running');
  await assert.rejects(manager.start('create'), /正在进行/);
  await manager.pending;
  const list = await manager.list();
  assert.equal(list.active.status, 'done');
  assert.equal(list.items.length, 1);
  await assert.rejects(manager.start('verify', '../secrets.json'), /标识/);
  await manager.start('verify', list.items[0].id);
  await manager.pending;
  assert.equal(manager.active.status, 'done');
  await manager.start('restore', list.items[0].id);
  await manager.pending;
  assert.equal(manager.active.status, 'done');
  assert.ok(manager.active.result.path.startsWith(join(dir, 'restored-')));
  assert.ok(existsSync(join(manager.active.result.path, 'xingxi.sqlite')));
  assert.equal(existsSync(join(manager.active.result.path, 'secrets.json')), false);
});

test('上一发布版的精确已知结构可验证并隔离升级，原备份不改变', async (t) => {
  const { dir, store, space } = fixture(t);
  const session = store.openSession(space.id, { binding: 'legacy-stable' });
  store.append(space.id, session.id, {
    role: 'user',
    body: '虚构旧版月桂消息',
    clientId: 'legacy',
  });
  dropChanges(store.db);
  store.db
    .exec(`DROP TRIGGER evidence_summary_delete; DROP TRIGGER summary_source_delete; DROP TRIGGER summary_item_delete;
    DROP TABLE summary_jobs; DROP TABLE summary_messages; DROP TABLE summary_search; DROP TABLE summary_items; DROP TABLE conversation_summaries;`);
  const backup = join(dir, 'legacy');
  const created = await createBackup(join(dir, 'xingxi.sqlite'), backup);
  assert.equal(
    created.manifest.schema,
    '29172325feaec65cc6a4a7d82740c4f50a5496cc337c31ac1aa3d20096a4eb1f',
  );
  const bytes = readFileSync(join(backup, 'xingxi.sqlite'));
  assert.equal((await verifyBackup(backup)).verified, true);
  const target = join(dir, 'legacy-restored');
  const result = await restoreBackup(backup, target);
  assert.equal(result.migrated, true);
  assert.deepEqual(readFileSync(join(backup, 'xingxi.sqlite')), bytes);
  const restored = new Store(join(target, 'xingxi.sqlite'));
  try {
    assert.equal(restored.openSession(space.id, { binding: 'legacy-stable' }).id, session.id);
    assert.equal(restored.conversationContext(space.id, '月桂').excerpts.length, 1);
    assert.equal(restored.summaries.list(space.id, session.id).coverage.total, 1);
    assert.deepEqual(restored.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    restored.close();
  }
});

test('摘要发布版备份可增量升级到变更版本，已审阅摘要继续召回', async (t) => {
  const { dir, store, space } = fixture(t);
  const session = store.createSession(space.id);
  const m = store.append(space.id, session.id, {
    role: 'assistant',
    body: '虚构月桂建议',
    clientId: 'summary',
  });
  const c = store.summaries.create(
    space.id,
    session.id,
    store.summaries.nextBatch(space.id, session.id),
    [
      {
        role: 'assistant',
        title: '月桂',
        body: m.body,
        evidence: [{ messageId: m.id, quote: m.body }],
      },
    ],
  );
  store.summaries.review(space.id, session.id, c.id, { revision: 1, status: 'accepted' });
  dropChanges(store.db);
  const backup = join(dir, 'summary-release');
  assert.equal(
    (await createBackup(join(dir, 'xingxi.sqlite'), backup)).manifest.schema,
    'e88c0ef5dc8d7cf2c49d48f9e4e1861b27f3bd38a85d388442c02a63dda91231',
  );
  const target = join(dir, 'summary-recovered');
  assert.equal((await restoreBackup(backup, target)).migrated, true);
  const recovered = new Store(join(target, 'xingxi.sqlite'));
  try {
    assert.equal(recovered.summaries.context(space.id, '月桂')[0].id, c.id);
    assert.equal(recovered.changes.list(space.id).items.length, 0);
  } finally {
    recovered.close();
  }
});
