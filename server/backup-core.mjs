import { DatabaseSync, backup } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import {
  mkdir,
  lstat,
  readFile,
  writeFile,
  chmod,
  copyFile,
  rename,
  rm,
  open,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { constants } from 'node:fs';
import { Store, Fault } from './store.mjs';

const baseTables = [
  'spaces',
  'sources',
  'entries',
  'revisions',
  'relations',
  'sessions',
  'messages',
  'session_bindings',
  'reply_evidence',
  'reply_evidence_items',
];
// Exact, previously shipped schema; never accept a schema supplied only by the manifest.
const legacySchema = '29172325feaec65cc6a4a7d82740c4f50a5496cc337c31ac1aa3d20096a4eb1f';
const summarySchema = 'e88c0ef5dc8d7cf2c49d48f9e4e1861b27f3bd38a85d388442c02a63dda91231';
const summaryTables = [
  'conversation_summaries',
  'summary_messages',
  'summary_items',
  'summary_jobs',
];
function tablesFor(schema) {
  if (schema === legacySchema) return baseTables;
  if (schema === summarySchema) return [...baseTables, ...summaryTables];
  if (schema === expectedSchemaHash())
    return [...baseTables, ...summaryTables, 'memory_changes', 'memory_change_events'];
  throw new Fault('备份数据库结构与此版本不匹配，请使用创建备份的版本恢复');
}
const digest = (data) => createHash('sha256').update(data).digest('hex');
const schemaHash = (db) =>
  digest(
    JSON.stringify(
      db
        .prepare(
          "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name",
        )
        .all()
        .map((row) => ({ ...row, sql: row.sql?.replace(/\s+/g, ' ').trim() })),
    ),
  );
let expectedSchema;
function expectedSchemaHash() {
  if (!expectedSchema) {
    const fresh = new Store(':memory:');
    try {
      expectedSchema = schemaHash(fresh.db);
    } finally {
      fresh.close();
    }
  }
  return expectedSchema;
}
async function fileHash(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
async function regular(path) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink())
    throw new Fault('备份文件必须是普通文件，不能是符号链接');
  return info;
}
async function flush(path) {
  const file = await open(path, 'r+');
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}
function inspect(path) {
  const db = new DatabaseSync(path, { readOnly: true, allowExtension: false });
  try {
    db.exec('PRAGMA trusted_schema=OFF; PRAGMA query_only=ON;');
    const schema = schemaHash(db);
    const tables = tablesFor(schema);
    const check = db.prepare('PRAGMA integrity_check').all();
    if (check.length !== 1 || Object.values(check[0])[0] !== 'ok')
      throw new Fault('备份数据库完整性校验失败');
    if (db.prepare('PRAGMA foreign_key_check').get()) throw new Fault('备份存在不完整的关联数据');
    const counts = Object.fromEntries(
      tables.map((table) => [table, db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n]),
    );
    const mismatched = db
      .prepare(
        `SELECT count(*) AS n FROM conversation_search f LEFT JOIN messages m ON m.rowid=f.rowid LEFT JOIN sessions s ON s.id=m.session_id WHERE m.id IS NULL OR m.role!='user' OR f.scope!='space'||replace(s.space_id,'-','')`,
      )
      .get().n;
    const missing = db
      .prepare(
        "SELECT count(*) AS n FROM messages m LEFT JOIN conversation_search f ON f.rowid=m.rowid WHERE m.role='user' AND f.rowid IS NULL",
      )
      .get().n;
    if (mismatched || missing) throw new Fault('聊天索引与原始消息不一致');
    if (schema !== legacySchema) {
      const invalidSummaryIndex = db
        .prepare(
          `SELECT count(*) AS n FROM summary_search f
        LEFT JOIN summary_items i ON i.id=f.rowid LEFT JOIN conversation_summaries c ON c.id=i.summary_id
        LEFT JOIN sessions s ON s.id=c.session_id WHERE i.id IS NULL OR f.scope!='space'||replace(s.space_id,'-','')`,
        )
        .get().n;
      const missingSummaryIndex = db
        .prepare(
          'SELECT count(*) AS n FROM summary_items i LEFT JOIN summary_search f ON f.rowid=i.id WHERE f.rowid IS NULL',
        )
        .get().n;
      if (invalidSummaryIndex || missingSummaryIndex) throw new Fault('摘要索引与原始摘要不一致');
    }
    if (schema === expectedSchemaHash()) {
      const invalid = db
        .prepare(
          "SELECT count(*) n FROM memory_change_search f LEFT JOIN memory_changes c ON c.sequence=f.rowid WHERE c.id IS NULL OR c.body='' OR f.scope!='space'||replace(c.space_id,'-','')",
        )
        .get().n;
      const missing = db
        .prepare(
          "SELECT count(*) n FROM memory_changes c LEFT JOIN memory_change_search f ON f.rowid=c.sequence WHERE c.body!='' AND f.rowid IS NULL",
        )
        .get().n;
      if (invalid || missing) throw new Fault('变更索引与原始记录不一致');
    }
    return { schema, counts };
  } finally {
    db.close();
  }
}
export async function readManifest(directory) {
  const path = join(directory, 'manifest.json');
  if ((await regular(path)).size > 65536) throw new Fault('备份清单过大');
  let data;
  try {
    data = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw new Fault('备份清单无法读取');
  }
  if (
    data?.format !== 'xingxi-backup' ||
    data.version !== 1 ||
    data.includesSecrets !== false ||
    !/^[a-f0-9]{64}$/.test(data.sha256) ||
    !Number.isSafeInteger(data.bytes) ||
    data.bytes < 1 ||
    typeof data.createdAt !== 'string'
  )
    throw new Fault('不是受支持的星汐备份清单');
  const tables = tablesFor(data.schema);
  if (
    !/^[a-f0-9]{64}$/.test(data.schema) ||
    !data.counts ||
    tables.some((table) => !Number.isSafeInteger(data.counts[table]) || data.counts[table] < 0)
  )
    throw new Fault('备份清单统计无效');
  return {
    format: data.format,
    version: data.version,
    createdAt: data.createdAt,
    includesSecrets: false,
    bytes: data.bytes,
    sha256: data.sha256,
    schema: data.schema,
    counts: Object.fromEntries(tables.map((table) => [table, data.counts[table]])),
  };
}
export async function createBackup(sourcePath, destination) {
  await regular(sourcePath);
  await mkdir(destination, { mode: 0o700 }); // Refuse any existing destination.
  let source;
  try {
    const path = join(destination, 'xingxi.sqlite');
    source = new DatabaseSync(sourcePath, { readOnly: true, allowExtension: false, timeout: 5000 });
    // SQLite's online backup includes committed WAL content and preserves rowids.
    await backup(source, path, { rate: 100 });
    source.close();
    source = null;
    await chmod(path, 0o600);
    const standalone = new DatabaseSync(path, { allowExtension: false });
    try {
      standalone.exec('PRAGMA trusted_schema=OFF; PRAGMA journal_mode=DELETE;');
    } finally {
      standalone.close();
    }
    const { schema, counts } = inspect(path);
    const manifest = {
      format: 'xingxi-backup',
      version: 1,
      createdAt: new Date().toISOString(),
      includesSecrets: false,
      bytes: (await regular(path)).size,
      sha256: await fileHash(path),
      schema,
      counts,
    };
    await flush(path);
    await writeFile(join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
    await flush(join(destination, 'manifest.json'));
    return { path: resolve(destination), manifest };
  } catch (error) {
    if (source) source.close();
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}
export async function verifyBackup(directory) {
  const manifest = await readManifest(directory);
  const path = join(directory, 'xingxi.sqlite');
  if ((await regular(path)).size !== manifest.bytes || (await fileHash(path)) !== manifest.sha256)
    throw new Fault('备份校验和不匹配，文件可能不完整或已改变');
  const result = inspect(path);
  if (
    result.schema !== manifest.schema ||
    JSON.stringify(result.counts) !== JSON.stringify(manifest.counts)
  )
    throw new Fault('备份清单与数据库不一致');
  return { path: resolve(directory), manifest, verified: true };
}
export async function restoreBackup(directory, destination) {
  const manifest = await readManifest(directory);
  // Never overwrite an active instance, even an apparently empty directory.
  await mkdir(destination, { mode: 0o700 });
  try {
    const path = join(destination, 'xingxi.sqlite.partial');
    await regular(join(directory, 'xingxi.sqlite'));
    await copyFile(join(directory, 'xingxi.sqlite'), path, constants.COPYFILE_EXCL);
    await chmod(path, 0o600);
    // Check the copied bytes, not only the source before copying (TOCTOU).
    if ((await regular(path)).size !== manifest.bytes || (await fileHash(path)) !== manifest.sha256)
      throw new Fault('恢复副本校验和不匹配');
    let checked = inspect(path);
    if (
      checked.schema !== manifest.schema ||
      JSON.stringify(checked.counts) !== JSON.stringify(manifest.counts)
    )
      throw new Fault('恢复副本与备份清单不一致');
    const migrated = checked.schema !== expectedSchemaHash();
    if (migrated) {
      // Only after verifying the copied legacy bytes, run our own additive migration.
      const upgraded = new Store(path);
      upgraded.close();
      const standalone = new DatabaseSync(path, { allowExtension: false });
      try {
        standalone.exec('PRAGMA journal_mode=DELETE;');
      } finally {
        standalone.close();
      }
      checked = inspect(path);
      if (checked.schema !== expectedSchemaHash()) throw new Fault('恢复副本升级失败');
    }
    await flush(path);
    await rename(path, join(destination, 'xingxi.sqlite'));
    return {
      path: resolve(destination),
      counts: checked.counts,
      restored: true,
      migrated,
      includesSecrets: false,
    };
  } catch (error) {
    await rm(destination, { recursive: true, force: true });
    throw error;
  }
}
