import { Fault, str, uid, now } from './store.mjs';
import { searchTerms } from './search.mjs';

// Arguments are trusted SQL expressions from repository code, never request text.
export function unsuperseded(kind, id, revision = '0', position = '-1') {
  return `NOT EXISTS (SELECT 1 FROM memory_changes mc WHERE mc.target_kind='${kind}' AND mc.target_id=${id}
    AND mc.target_position=${position} AND mc.target_revision=${revision}
    AND mc.status IN ('accepted','unavailable') AND mc.effective_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;
}
const latest = (
  alias,
) => `NOT EXISTS (SELECT 1 FROM memory_changes newer WHERE newer.target_kind=${alias}.target_kind
  AND newer.target_id=${alias}.target_id AND newer.target_position=${alias}.target_position AND newer.target_revision=${alias}.target_revision
  AND newer.status IN ('accepted','unavailable') AND newer.effective_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
  AND (newer.effective_at>${alias}.effective_at OR (newer.effective_at=${alias}.effective_at AND newer.sequence>${alias}.sequence)))`;
const stateOf = (row) =>
  !row.source_ok
    ? 'unavailable'
    : !row.target_ok
      ? 'stale'
      : row.status !== 'accepted'
        ? row.status
        : row.effective_at > now()
          ? 'scheduled'
          : !row.latest_due
            ? 'superseded'
            : !row.enabled
              ? 'disabled'
              : 'active';

export class MemoryChanges {
  constructor(store) {
    this.store = store;
    this.db = store.db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_changes(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,space_id TEXT NOT NULL REFERENCES spaces(id),kind TEXT NOT NULL,target_kind TEXT NOT NULL,target_id TEXT NOT NULL,target_position INTEGER NOT NULL,target_revision INTEGER NOT NULL,source_kind TEXT NOT NULL,source_id TEXT NOT NULL,quote TEXT NOT NULL,title TEXT NOT NULL,body TEXT NOT NULL,effective_at TEXT NOT NULL,status TEXT NOT NULL,revision INTEGER NOT NULL,created_at TEXT NOT NULL,target_snapshot TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS memory_changes_target ON memory_changes(target_kind,target_id,target_position,target_revision,status,effective_at DESC,sequence DESC);
      CREATE INDEX IF NOT EXISTS memory_changes_source ON memory_changes(source_kind,source_id);
      CREATE INDEX IF NOT EXISTS memory_changes_page ON memory_changes(space_id,sequence DESC);
      CREATE TABLE IF NOT EXISTS memory_change_events(change_id TEXT NOT NULL REFERENCES memory_changes(id) ON DELETE CASCADE,revision INTEGER NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(change_id,revision));
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_change_search USING fts5(scope,terms);
      CREATE TRIGGER IF NOT EXISTS change_deleted AFTER DELETE ON memory_changes BEGIN DELETE FROM memory_change_search WHERE rowid=old.sequence; END;
      CREATE TRIGGER IF NOT EXISTS change_status AFTER UPDATE OF status ON memory_changes BEGIN
        INSERT INTO memory_change_events VALUES(new.id,new.revision,new.status,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
        DELETE FROM memory_change_search WHERE rowid=new.sequence AND new.body='';
      END;
      CREATE TRIGGER IF NOT EXISTS change_message_deleted BEFORE DELETE ON messages BEGIN
        DELETE FROM memory_changes WHERE target_kind='conversation' AND target_id=old.id;
        UPDATE memory_changes SET status=CASE WHEN status IN ('accepted','unavailable') THEN 'unavailable' ELSE 'archived' END,revision=revision+1,title='',body='',quote='',target_snapshot='{}'
          WHERE source_kind='conversation' AND source_id=old.id;
      END;
      CREATE TRIGGER IF NOT EXISTS change_source_deleted BEFORE DELETE ON sources BEGIN
        UPDATE memory_changes SET status=CASE WHEN status IN ('accepted','unavailable') THEN 'unavailable' ELSE 'archived' END,revision=revision+1,title='',body='',quote='',target_snapshot='{}'
          WHERE source_kind='source' AND source_id=old.id;
      END;
      CREATE TRIGGER IF NOT EXISTS change_entry_deleted BEFORE DELETE ON entries BEGIN DELETE FROM memory_changes WHERE target_kind='knowledge' AND target_id=old.id; END;
      CREATE TRIGGER IF NOT EXISTS change_summary_deleted BEFORE DELETE ON conversation_summaries BEGIN DELETE FROM memory_changes WHERE target_kind='summary' AND target_id=old.id; END;
      CREATE VIEW IF NOT EXISTS memory_change_state AS SELECT c.*,
        CASE c.target_kind WHEN 'knowledge' THEN e.revision=c.target_revision AND e.status='accepted'
          WHEN 'conversation' THEN m.id IS NOT NULL
          WHEN 'summary' THEN s.revision=c.target_revision AND s.status='accepted' AND si.id IS NOT NULL END AS target_ok,
        CASE c.source_kind WHEN 'source' THEN src.id IS NOT NULL ELSE sm.id IS NOT NULL AND sm.role='user' END AS source_ok,
        CASE WHEN c.target_kind='knowledge' AND c.source_kind='source' THEN 1 ELSE COALESCE(spm.enabled,1) END
          *COALESCE(tm.enabled,1)*COALESCE(ssm.enabled,1) AS enabled
      FROM memory_changes c
      LEFT JOIN entries e ON c.target_kind='knowledge' AND e.id=c.target_id AND e.space_id=c.space_id
      LEFT JOIN messages m ON c.target_kind='conversation' AND m.id=c.target_id
      LEFT JOIN conversation_summaries s ON c.target_kind='summary' AND s.id=c.target_id
      LEFT JOIN summary_items si ON si.summary_id=s.id AND si.position=c.target_position
      LEFT JOIN sources src ON c.source_kind='source' AND src.id=c.source_id AND src.space_id=c.space_id
      LEFT JOIN messages sm ON c.source_kind='conversation' AND sm.id=c.source_id
      LEFT JOIN space_memory spm ON spm.space_id=c.space_id
      LEFT JOIN session_memory tm ON tm.session_id=COALESCE(m.session_id,s.session_id)
      LEFT JOIN session_memory ssm ON ssm.session_id=sm.session_id;
    `);
  }
  target(spaceId, { kind, id, position = -1 }) {
    this.store.space(spaceId);
    let value;
    if (kind === 'knowledge') {
      const entry = this.store.entry(spaceId, id);
      value = {
        title: entry.title,
        body: entry.body,
        revision: entry.revision,
        status: entry.status,
        role: 'knowledge',
        created_at: entry.updated_at,
      };
    } else if (kind === 'conversation') {
      const message = this.db
        .prepare(
          'SELECT m.*,s.title FROM messages m JOIN sessions s ON s.id=m.session_id WHERE m.id=? AND s.space_id=?',
        )
        .get(id, spaceId);
      if (!message) throw new Fault('此空间没有这条消息', 404);
      value = { ...message, revision: 0, status: 'accepted' };
    } else if (kind === 'summary') {
      if (!Number.isSafeInteger(position) || position < 0 || position > 7)
        throw new Fault('摘要项位置无效');
      const summary = this.db
        .prepare(
          'SELECT s.* FROM conversation_summaries s JOIN sessions c ON c.id=s.session_id WHERE s.id=? AND c.space_id=?',
        )
        .get(id, spaceId);
      if (!summary) throw new Fault('此空间没有这份摘要', 404);
      const item = this.store.summaries.read(spaceId, summary.session_id, id).items[position];
      if (!item) throw new Fault('摘要项不存在', 404);
      value = {
        ...item,
        revision: summary.revision,
        status: summary.status,
        session_id: summary.session_id,
        created_at: summary.created_at,
      };
    } else throw new Fault('变更目标类型无效');
    return { kind, id, position: kind === 'summary' ? position : -1, ...value };
  }
  source(spaceId, { kind, id, quote }) {
    let value;
    if (kind === 'source') value = this.store.source(spaceId, id);
    else if (kind === 'conversation') {
      value = this.target(spaceId, { kind, id });
      if (value.role !== 'user') throw new Fault('纠正依据必须来自用户原话，不能使用助手建议');
    } else throw new Fault('变更依据类型无效');
    quote = str(quote, '纠正依据摘录', 1000);
    if (!value.body.includes(quote)) throw new Fault('纠正依据必须逐字来自原文');
    return {
      kind,
      id,
      quote,
      origin: value.origin,
      created_at: value.created_at,
      session_id: value.session_id,
    };
  }
  propose(spaceId, input) {
    return this.store.transaction(() => {
      const target = this.target(spaceId, input.target || {});
      if (target.status !== 'accepted') throw new Fault('请先确认目标知识或摘要');
      if (input.target.revision !== target.revision)
        throw new Fault('目标内容已更新，请重新选择', 409);
      const source = this.source(spaceId, input.source || {});
      if (!['correction', 'change', 'conflict'].includes(input.kind))
        throw new Fault('变更类型无效');
      const effective = input.effectiveAt === undefined ? now() : input.effectiveAt;
      const timeParts =
        typeof effective === 'string' &&
        effective.match(
          /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/,
        );
      if (
        !timeParts ||
        !Number.isFinite(Date.parse(effective)) ||
        Number(timeParts[2]) > 23 ||
        Number(timeParts[3]) > 59 ||
        Number(timeParts[4]) > 59 ||
        new Date(`${timeParts[1]}T00:00:00Z`).toISOString().slice(0, 10) !== timeParts[1]
      )
        throw new Fault('生效时间需为有效日期并带时区');
      const id = uid(),
        title = str(input.title, '变更主题', 120),
        body = str(input.body, '变更说明', 1000);
      const snapshot = {
        kind: target.kind,
        id: target.id,
        position: target.position,
        revision: target.revision,
        title: target.title,
        body: target.body.slice(0, 1200),
        role: target.role,
        created_at: target.created_at,
        truncated: target.body.length > 1200,
      };
      const result = this.db
        .prepare(
          `INSERT INTO memory_changes(id,space_id,kind,target_kind,target_id,target_position,target_revision,source_kind,source_id,quote,title,body,effective_at,status,revision,created_at,target_snapshot) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',1,?,?)`,
        )
        .run(
          id,
          spaceId,
          input.kind,
          target.kind,
          target.id,
          target.position,
          target.revision,
          source.kind,
          source.id,
          source.quote,
          title,
          body,
          new Date(effective).toISOString(),
          now(),
          JSON.stringify(snapshot),
        );
      this.db.prepare('INSERT INTO memory_change_events VALUES(?,1,?,?)').run(id, 'pending', now());
      this.db
        .prepare('INSERT INTO memory_change_search(rowid,scope,terms) VALUES(?,?,?)')
        .run(
          Number(result.lastInsertRowid),
          `space${spaceId.replaceAll('-', '')}`,
          searchTerms(`${title} ${body} ${target.title} ${target.body}`, true).join(' '),
        );
      return this.read(spaceId, id);
    });
  }
  manual(spaceId, input) {
    return this.store.transaction(() => {
      const body = str(input.body, '你的纠正或冲突说明', 1000);
      const title = str(input.title, '变更主题', 120);
      const source = this.store.ingest(spaceId, {
        title: `记忆变更依据：${title}`,
        body,
        origin: 'manual',
      });
      return this.propose(spaceId, {
        ...input,
        body,
        title,
        source: { kind: 'source', id: source.id, quote: body },
      });
    });
  }
  candidates(spaceId, query = '') {
    const knowledge = this.store.views.entries(spaceId, { q: query, limit: 10 }).items.map((e) => ({
      kind: 'knowledge',
      id: e.id,
      position: -1,
      revision: e.revision,
      title: e.title,
      body: e.preview,
      role: 'knowledge',
    }));
    const conversation = this.store.conversations
      .search(spaceId, query, { limit: 10, includeSuperseded: true })
      .map((m) => ({
        kind: 'conversation',
        id: m.id,
        position: -1,
        revision: 0,
        title: m.session_title,
        body: m.quote.slice(0, 240),
        role: 'user',
      }));
    const summaries = this.store.summaries
      .context(spaceId, query, { includeSuperseded: true })
      .map((s) => ({
        kind: 'summary',
        id: s.id,
        position: s.position,
        revision: s.revision,
        title: s.title,
        body: s.body.slice(0, 240),
        role: s.role,
      }));
    return { items: [...knowledge, ...conversation, ...summaries] };
  }
  read(spaceId, id) {
    this.store.space(spaceId);
    const row = this.db
      .prepare(
        `SELECT c.*,${latest('c')} AS latest_due FROM memory_change_state c WHERE c.id=? AND c.space_id=?`,
      )
      .get(id, spaceId);
    if (!row) throw new Fault('此空间没有这条变更', 404);
    return {
      ...row,
      state: stateOf(row),
      target: JSON.parse(row.target_snapshot),
      target_snapshot: undefined,
      events: this.db
        .prepare(
          'SELECT revision,status,created_at FROM memory_change_events WHERE change_id=? ORDER BY revision DESC LIMIT 20',
        )
        .all(id),
    };
  }
  forTarget(spaceId, target) {
    this.store.space(spaceId);
    const row = this.db
      .prepare(
        "SELECT id FROM memory_changes WHERE space_id=? AND target_kind=? AND target_id=? AND target_position=? AND target_revision=? AND status IN ('accepted','unavailable') AND effective_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now') ORDER BY effective_at DESC,sequence DESC LIMIT 1",
      )
      .get(spaceId, target.kind, target.id, target.position ?? -1, target.revision);
    if (!row) return null;
    const change = this.read(spaceId, row.id);
    if (!change.enabled || !change.source_ok)
      return {
        id: change.id,
        kind: change.kind,
        state: change.state,
        effective_at: change.effective_at,
        revision: change.revision,
        status: change.status,
        title: '变更暂不可用于召回',
        body: '',
      };
    return change;
  }
  auditTarget(spaceId, id) {
    return this.db
      .prepare(
        `SELECT c.revision,c.status,c.enabled,c.target_ok,${latest('c')} AS latest_due FROM memory_change_state c WHERE c.id=? AND c.space_id=? AND c.source_ok=1 AND c.body!=''`,
      )
      .get(id, spaceId);
  }
  review(spaceId, id, { revision, status }) {
    return this.store.transaction(() => {
      const row = this.read(spaceId, id);
      if (revision !== row.revision) throw new Fault('变更已更新，请刷新后审阅', 409);
      if (!['accepted', 'archived'].includes(status)) throw new Fault('请选择确认或归档');
      if (status === 'accepted') {
        if (row.status === 'unavailable' || !row.source_ok) throw new Fault('依据已删除，不能确认');
        if (!row.target_ok) throw new Fault('目标版本或状态已变化，请创建新的变更', 409);
        this.source(spaceId, { kind: row.source_kind, id: row.source_id, quote: row.quote });
      }
      this.db
        .prepare('UPDATE memory_changes SET status=?,revision=revision+1 WHERE id=?')
        .run(status, id);
      return this.read(spaceId, id);
    });
  }
  list(spaceId, { before, status = 'all' } = {}) {
    this.store.space(spaceId);
    if (!['all', 'pending', 'accepted', 'archived', 'unavailable'].includes(status))
      throw new Fault('变更筛选无效');
    const cursor = before === undefined ? Number.MAX_SAFE_INTEGER : Number(before);
    if (!Number.isSafeInteger(cursor) || cursor < 1) throw new Fault('变更游标无效');
    const rows = this.db
      .prepare(
        `SELECT c.sequence,c.id,c.title,c.kind,c.status,c.revision,c.effective_at,c.created_at,c.target_kind,c.target_id,c.target_position,c.target_ok,c.source_ok,c.enabled,${latest('c')} AS latest_due FROM memory_change_state c WHERE c.space_id=? AND c.sequence<? ${status === 'all' ? '' : 'AND c.status=?'} ORDER BY c.sequence DESC LIMIT 21`,
      )
      .all(spaceId, cursor, ...(status === 'all' ? [] : [status]));
    return {
      items: rows.slice(0, 20).map((row) => ({ ...row, state: stateOf(row) })),
      hasMore: rows.length > 20,
      nextBefore: rows.length > 20 ? rows[19].sequence : null,
    };
  }
  context(spaceId, query = '') {
    this.store.space(spaceId);
    const terms = searchTerms(String(query).slice(0, 2000)).slice(0, 40);
    const match =
      `scope : "space${spaceId.replaceAll('-', '')}"` +
      (terms.length ? ` AND terms : (${terms.map((t) => `"${t}"`).join(' OR ')})` : '');
    const rows = this.db
      .prepare(
        `SELECT c.* FROM memory_change_search f JOIN memory_change_state c ON c.sequence=f.rowid WHERE memory_change_search MATCH ? AND c.space_id=? AND c.status='accepted' AND c.target_ok=1 AND c.source_ok=1 AND c.enabled=1 AND c.effective_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now') AND ${latest('c')} ORDER BY ${terms.length ? 'rank,' : ''} c.effective_at DESC,c.sequence DESC LIMIT 6`,
      )
      .all(match, spaceId);
    return rows.map((row) => ({
      id: row.id,
      revision: row.revision,
      title: row.title,
      body: row.body,
      kind: row.kind,
      effectiveAt: row.effective_at,
      target: {
        kind: row.target_kind,
        id: row.target_id,
        position: row.target_position,
        revision: row.target_revision,
      },
      source: this.source(spaceId, { kind: row.source_kind, id: row.source_id, quote: row.quote }),
      basis: 'reviewed-memory-change',
    }));
  }
}
