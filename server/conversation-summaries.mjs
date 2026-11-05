import { Fault, uid, now, str } from './store.mjs';
import { searchTerms } from './search.mjs';

export class ConversationSummaries {
  constructor(store) {
    this.store = store;
    this.db = store.db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_summaries(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,first_sequence INTEGER NOT NULL,last_sequence INTEGER NOT NULL,covered_count INTEGER NOT NULL,status TEXT NOT NULL,revision INTEGER NOT NULL,created_at TEXT NOT NULL,UNIQUE(session_id,last_sequence));
      CREATE TABLE IF NOT EXISTS summary_messages(summary_id TEXT NOT NULL REFERENCES conversation_summaries(id) ON DELETE CASCADE,message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,PRIMARY KEY(summary_id,message_id));
      CREATE INDEX IF NOT EXISTS summary_message_target ON summary_messages(message_id);
      CREATE TABLE IF NOT EXISTS summary_items(id INTEGER PRIMARY KEY AUTOINCREMENT,summary_id TEXT NOT NULL REFERENCES conversation_summaries(id) ON DELETE CASCADE,position INTEGER NOT NULL,role TEXT NOT NULL,title TEXT NOT NULL,body TEXT NOT NULL,evidence TEXT NOT NULL,UNIQUE(summary_id,position));
      CREATE VIRTUAL TABLE IF NOT EXISTS summary_search USING fts5(scope,terms);
      CREATE TRIGGER IF NOT EXISTS summary_item_delete AFTER DELETE ON summary_items BEGIN DELETE FROM summary_search WHERE rowid=old.id; END;
      CREATE TRIGGER IF NOT EXISTS summary_source_delete BEFORE DELETE ON messages BEGIN DELETE FROM conversation_summaries WHERE id IN (SELECT summary_id FROM summary_messages WHERE message_id=old.id); END;
      CREATE TABLE IF NOT EXISTS summary_jobs(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,status TEXT NOT NULL,summary_id TEXT REFERENCES conversation_summaries(id) ON DELETE SET NULL,error TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS summary_jobs_session ON summary_jobs(session_id,created_at DESC);
    `);
  }
  scope(spaceId) {
    return `space${spaceId.replaceAll('-', '')}`;
  }
  cursor(sessionId) {
    return this.db
      .prepare(
        'SELECT COALESCE(MAX(last_sequence),0) AS n FROM conversation_summaries WHERE session_id=?',
      )
      .get(sessionId).n;
  }
  nextBatch(spaceId, sessionId) {
    this.store.sessionMeta(spaceId, sessionId);
    const messages = [];
    let chars = 0;
    for (const m of this.db
      .prepare(
        'SELECT rowid AS sequence,* FROM messages WHERE session_id=? AND rowid>? ORDER BY rowid LIMIT 40',
      )
      .iterate(sessionId, this.cursor(sessionId))) {
      if (chars + m.body.length > 24000 && messages.length) break;
      messages.push(m);
      chars += m.body.length;
    }
    return messages;
  }
  validateItems(items, messages) {
    if (!Array.isArray(items) || items.length > 8) throw new Fault('摘要应包含最多 8 项内容');
    const map = new Map(messages.map((m) => [m.id, m]));
    return items.map((item) => {
      if (!item || !['user', 'assistant'].includes(item.role))
        throw new Fault('摘要必须区分用户与助手角色');
      if (!Array.isArray(item.evidence) || !item.evidence.length || item.evidence.length > 4)
        throw new Fault('摘要需有 1–4 处原消息依据');
      const evidence = item.evidence.map((ev) => {
        const m = map.get(ev?.messageId);
        if (!m || m.role !== item.role) throw new Fault('摘要出处角色或消息范围不匹配');
        const quote = str(ev.quote, '原话摘录', 500);
        if (!m.body.includes(quote)) throw new Fault('摘要摘录必须逐字来自对应消息');
        return { messageId: m.id, role: m.role, quote, created_at: m.created_at };
      });
      return {
        role: item.role,
        title: str(item.title, '摘要标题', 120),
        body: str(item.body, '摘要内容', 1000),
        evidence,
      };
    });
  }
  create(spaceId, sessionId, captured, items) {
    this.store.sessionMeta(spaceId, sessionId);
    return this.store.transaction(() => {
      const actual = captured.map((m) =>
        this.db
          .prepare('SELECT rowid AS sequence,* FROM messages WHERE id=? AND session_id=?')
          .get(m.id, sessionId),
      );
      if (
        !actual.length ||
        actual.some((m, i) => !m || m.body !== captured[i].body || m.role !== captured[i].role)
      )
        throw new Fault('原会话内容已改变，请重新整理');
      if (actual[0].sequence <= this.cursor(sessionId))
        throw new Fault('这段会话已被整理，请刷新', 409);
      const validated = this.validateItems(items, actual);
      const id = uid();
      this.db
        .prepare('INSERT INTO conversation_summaries VALUES(?,?,?,?,?,?,?,?)')
        .run(
          id,
          sessionId,
          actual[0].sequence,
          actual.at(-1).sequence,
          actual.length,
          'pending',
          1,
          now(),
        );
      for (const m of actual)
        this.db.prepare('INSERT INTO summary_messages VALUES(?,?)').run(id, m.id);
      this.writeItems(spaceId, id, validated);
      return this.read(spaceId, sessionId, id);
    });
  }
  writeItems(spaceId, id, items) {
    this.db.prepare('DELETE FROM summary_items WHERE summary_id=?').run(id);
    for (const [position, item] of items.entries()) {
      const result = this.db
        .prepare(
          'INSERT INTO summary_items(summary_id,position,role,title,body,evidence) VALUES(?,?,?,?,?,?)',
        )
        .run(id, position, item.role, item.title, item.body, JSON.stringify(item.evidence));
      this.db
        .prepare('INSERT INTO summary_search(rowid,scope,terms) VALUES(?,?,?)')
        .run(
          Number(result.lastInsertRowid),
          this.scope(spaceId),
          searchTerms(`${item.title} ${item.body}`, true).join(' '),
        );
    }
  }
  read(spaceId, sessionId, id) {
    this.store.sessionMeta(spaceId, sessionId);
    const row = this.db
      .prepare('SELECT * FROM conversation_summaries WHERE id=? AND session_id=?')
      .get(id, sessionId);
    if (!row) throw new Fault('此会话没有这份摘要', 404);
    return {
      ...row,
      items: this.db
        .prepare(
          'SELECT position,role,title,body,evidence FROM summary_items WHERE summary_id=? ORDER BY position',
        )
        .all(id)
        .map((item) => ({ ...item, evidence: JSON.parse(item.evidence) })),
    };
  }
  review(spaceId, sessionId, id, { revision, status, items }) {
    return this.store.transaction(() => {
      const current = this.read(spaceId, sessionId, id);
      if (revision !== current.revision) throw new Fault('摘要已更新，请刷新后再修改', 409);
      if (!['pending', 'accepted', 'archived'].includes(status)) throw new Fault('摘要状态无效');
      if (items !== undefined) {
        const messages = this.db
          .prepare(
            'SELECT m.* FROM messages m JOIN summary_messages sm ON sm.message_id=m.id WHERE sm.summary_id=?',
          )
          .all(id);
        this.writeItems(spaceId, id, this.validateItems(items, messages));
      }
      this.db
        .prepare('UPDATE conversation_summaries SET status=?,revision=revision+1 WHERE id=?')
        .run(status, id);
      return this.read(spaceId, sessionId, id);
    });
  }
  list(spaceId, sessionId, { before } = {}) {
    this.store.sessionMeta(spaceId, sessionId);
    const cursor = before === undefined ? Number.MAX_SAFE_INTEGER : Number(before);
    if (!Number.isSafeInteger(cursor) || cursor < 1) throw new Fault('摘要游标无效');
    const rows = this.db
      .prepare(
        'SELECT s.*,(SELECT count(*) FROM summary_items i WHERE i.summary_id=s.id) AS item_count FROM conversation_summaries s WHERE session_id=? AND last_sequence<? ORDER BY last_sequence DESC LIMIT 21',
      )
      .all(sessionId, cursor);
    const total = this.db
      .prepare('SELECT count(*) AS n FROM messages WHERE session_id=?')
      .get(sessionId).n;
    const covered = this.db
      .prepare(
        'SELECT COALESCE(sum(covered_count),0) AS n FROM conversation_summaries WHERE session_id=?',
      )
      .get(sessionId).n;
    return {
      summaries: rows.slice(0, 20),
      hasMore: rows.length > 20,
      nextBefore: rows.length > 20 ? rows[19].last_sequence : null,
      coverage: { total, covered },
      jobs: this.db
        .prepare('SELECT * FROM summary_jobs WHERE session_id=? ORDER BY created_at DESC LIMIT 5')
        .all(sessionId),
    };
  }
  context(spaceId, query = '', { excludeIds = [] } = {}) {
    this.store.space(spaceId);
    if (!this.store.conversations.enabled(spaceId)) return [];
    const terms = searchTerms(String(query).slice(0, 2000)).slice(0, 40);
    const match =
      `scope : "${this.scope(spaceId)}"` +
      (terms.length ? ` AND terms : (${terms.map((t) => `"${t}"`).join(' OR ')})` : '');
    const excluded = excludeIds.slice(0, 100);
    const rows = this.db
      .prepare(
        `SELECT i.position,i.role,i.title,i.body,i.evidence,s.id,s.revision,s.created_at,s.session_id,c.title AS session_title
      FROM summary_search JOIN summary_items i ON i.id=summary_search.rowid
      JOIN conversation_summaries s ON s.id=i.summary_id JOIN sessions c ON c.id=s.session_id
      LEFT JOIN session_memory sm ON sm.session_id=c.id
      WHERE summary_search MATCH ? AND c.space_id=? AND s.status='accepted' AND COALESCE(sm.enabled,1)=1
      ${excluded.length ? `AND NOT EXISTS (SELECT 1 FROM json_each(i.evidence) ev WHERE json_extract(ev.value,'$.messageId') IN (${excluded.map(() => '?').join(',')}))` : ''}
      ORDER BY ${terms.length ? 'rank,' : ''} s.last_sequence DESC,i.position LIMIT 4`,
      )
      .all(match, spaceId, ...excluded);
    return rows.map((r) => ({
      ...r,
      body: r.body.slice(0, 800),
      truncated: r.body.length > 800 || JSON.parse(r.evidence).length > 2,
      evidence: JSON.parse(r.evidence)
        .slice(0, 2)
        .map((ev) => ({ ...ev, quote: ev.quote.slice(0, 240), truncated: ev.quote.length > 240 })),
      basis: 'reviewed-conversation-summary',
      status: 'summary',
    }));
  }
}
