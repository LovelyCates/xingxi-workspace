import { searchTerms } from './search.mjs';
import { unsuperseded } from './memory-changes.mjs';

// Rebuildable local index of user quotations. Never promotes generated claims to facts.
export class ConversationMemory {
  constructor(store) {
    this.store = store;
    this.db = store.db;
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS conversation_search USING fts5(scope, terms);
      CREATE TABLE IF NOT EXISTS space_memory(space_id TEXT PRIMARY KEY REFERENCES spaces(id), enabled INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS session_memory(session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE, enabled INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS session_bindings(space_id TEXT NOT NULL REFERENCES spaces(id), binding TEXT NOT NULL, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, PRIMARY KEY(space_id,binding));
      CREATE TRIGGER IF NOT EXISTS message_search_delete AFTER DELETE ON messages BEGIN
        DELETE FROM conversation_search WHERE rowid=old.rowid;
      END;
    `);
    if (!this.db.prepare('SELECT 1 FROM migrations WHERE name=?').get('conversation-index-v1')) {
      store.transaction(() => {
        for (const m of this.db
          .prepare(
            "SELECT m.rowid AS sequence,m.*,s.space_id FROM messages m JOIN sessions s ON s.id=m.session_id WHERE m.role='user'",
          )
          .iterate())
          this.index(m.space_id, m);
        this.db.prepare('INSERT INTO migrations VALUES(?)').run('conversation-index-v1');
      });
    }
  }
  scope(spaceId) {
    return `space${spaceId.replaceAll('-', '')}`;
  }
  index(spaceId, message) {
    if (message.role !== 'user') return;
    this.db
      .prepare('INSERT INTO conversation_search(rowid,scope,terms) VALUES(?,?,?)')
      .run(message.sequence, this.scope(spaceId), searchTerms(message.body, true).join(' '));
  }
  enabled(spaceId) {
    return (
      this.db.prepare('SELECT enabled FROM space_memory WHERE space_id=?').get(spaceId)?.enabled !==
      0
    );
  }
  search(
    spaceId,
    query = '',
    { excludeIds = [], limit = 6, recent = false, includeSuperseded = false } = {},
  ) {
    this.store.space(spaceId);
    if (!this.enabled(spaceId)) return [];
    const terms = searchTerms(String(query).slice(0, 2000)).slice(0, 40);
    const match =
      `scope : "${this.scope(spaceId)}"` +
      (terms.length
        ? ` AND terms : (${terms.map((t) => `"${t.replaceAll('"', '""')}"`).join(' OR ')})`
        : '');
    const excluded = excludeIds.slice(0, 100);
    const rows = this.db
      .prepare(
        `SELECT m.id,m.session_id,m.body,m.created_at,s.title AS session_title
      FROM conversation_search JOIN messages m ON m.rowid=conversation_search.rowid
      JOIN sessions s ON s.id=m.session_id
      LEFT JOIN session_memory sm ON sm.session_id=s.id
      WHERE conversation_search MATCH ? AND s.space_id=? AND COALESCE(sm.enabled,1)=1
      ${includeSuperseded ? '' : `AND ${unsuperseded('conversation', 'm.id')}`}
      ${excluded.length ? `AND m.id NOT IN (${excluded.map(() => '?').join(',')})` : ''}
      ORDER BY ${terms.length && !recent ? 'rank,' : ''} conversation_search.rowid DESC LIMIT ?`,
      )
      .all(match, spaceId, ...excluded, Math.max(1, Math.min(12, Number(limit) || 6)));
    return rows.map((row) => {
      // A bounded verbatim excerpt around a matching term, not a model-generated summary.
      const lower = row.body.toLowerCase();
      const positions = terms.map((t) => lower.indexOf(t)).filter((p) => p >= 0);
      const start = Math.max(0, (positions.length ? Math.min(...positions) : 0) - 160);
      return {
        ...row,
        body: undefined,
        quote: row.body.slice(start, start + 1200),
        truncated: start > 0 || row.body.length > start + 1200,
        role: 'user',
        status: 'conversation',
        basis: 'verbatim-user-message',
      };
    });
  }
}
