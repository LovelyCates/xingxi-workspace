import { Fault, now } from './store.mjs';

// Audit only: these snapshots are never queried as new model memory.
export class ReplyEvidence {
  constructor(store) {
    this.store = store;
    this.db = store.db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS reply_evidence(
        message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
        model TEXT NOT NULL, created_at TEXT NOT NULL, version INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS reply_evidence_items(
        reply_id TEXT NOT NULL REFERENCES reply_evidence(message_id) ON DELETE CASCADE,
        kind TEXT NOT NULL, ordinal INTEGER NOT NULL, target_id TEXT NOT NULL,
        payload TEXT, state TEXT NOT NULL DEFAULT 'available',
        PRIMARY KEY(reply_id,kind,ordinal)
      );
      CREATE TRIGGER IF NOT EXISTS evidence_summary_delete AFTER DELETE ON conversation_summaries BEGIN UPDATE reply_evidence_items SET payload=NULL,state='deleted' WHERE target_id=old.id AND kind='summary'; END;
      CREATE INDEX IF NOT EXISTS evidence_target ON reply_evidence_items(target_id,kind);
      CREATE TRIGGER IF NOT EXISTS evidence_message_delete AFTER DELETE ON messages BEGIN
        UPDATE reply_evidence_items SET payload=NULL,state='deleted'
        WHERE target_id=old.id AND kind IN ('conversation','recent');
      END;
      CREATE TRIGGER IF NOT EXISTS evidence_entry_delete AFTER DELETE ON entries BEGIN
        UPDATE reply_evidence_items SET payload=NULL,state='deleted'
        WHERE target_id=old.id AND kind='knowledge';
      END;
    `);
  }
  save(spaceId, sessionId, messageId, { model, knowledge, conversation, recent, summary = [] }) {
    const reply = this.message(spaceId, sessionId, messageId);
    if (reply.role !== 'assistant') throw new Fault('只有助手回答可以记录参考依据');
    if (knowledge.length > 8 || conversation.length > 8 || recent.length > 20 || summary.length > 4)
      throw new Fault('回答参考依据超出预算');
    this.store.transaction(() => {
      this.db.prepare('INSERT INTO reply_evidence VALUES(?,?,?,1)').run(messageId, model, now());
      for (const [kind, items] of Object.entries({ knowledge, conversation, recent, summary })) {
        items.forEach((item, ordinal) => {
          const target = this.target(spaceId, kind, item.id);
          // A recalled conversation may be deleted while the model is answering.
          // Do not recreate its quotation from the in-flight request snapshot.
          this.db
            .prepare('INSERT INTO reply_evidence_items VALUES(?,?,?,?,?,?)')
            .run(
              messageId,
              kind,
              ordinal,
              item.id,
              target ? JSON.stringify(item) : null,
              target ? 'available' : 'deleted',
            );
        });
      }
    });
  }
  message(spaceId, sessionId, messageId) {
    this.store.sessionMeta(spaceId, sessionId);
    const row = this.db
      .prepare('SELECT * FROM messages WHERE id=? AND session_id=?')
      .get(messageId, sessionId);
    if (!row) throw new Fault('此会话中没有这条消息', 404);
    return row;
  }
  target(spaceId, kind, id) {
    if (kind === 'summary')
      return this.db
        .prepare(
          'SELECT s.revision,s.status,COALESCE(sm.enabled,1) AS enabled FROM conversation_summaries s JOIN sessions c ON c.id=s.session_id LEFT JOIN session_memory sm ON sm.session_id=c.id WHERE s.id=? AND c.space_id=?',
        )
        .get(id, spaceId);
    if (kind === 'knowledge')
      return this.db
        .prepare('SELECT revision,status FROM entries WHERE id=? AND space_id=?')
        .get(id, spaceId);
    return this.db
      .prepare(
        `SELECT m.role,COALESCE(sm.enabled,1) AS enabled
      FROM messages m JOIN sessions s ON s.id=m.session_id
      LEFT JOIN session_memory sm ON sm.session_id=s.id
      WHERE m.id=? AND s.space_id=?`,
      )
      .get(id, spaceId);
  }
  read(spaceId, sessionId, messageId) {
    this.message(spaceId, sessionId, messageId);
    const header = this.db
      .prepare('SELECT * FROM reply_evidence WHERE message_id=?')
      .get(messageId);
    if (!header)
      return {
        recorded: false,
        messageId,
        items: [],
        note: '这条消息没有保存生成时的参考记录，不能事后推断。',
      };
    const enabled = this.store.conversations.enabled(spaceId);
    const items = this.db
      .prepare('SELECT * FROM reply_evidence_items WHERE reply_id=? ORDER BY kind,ordinal')
      .all(messageId)
      .map((row) => {
        const base = { kind: row.kind, ordinal: row.ordinal, targetId: row.target_id };
        const target = this.target(spaceId, row.kind, row.target_id);
        if (row.state === 'deleted' || !target || !row.payload)
          return { ...base, state: 'deleted' };
        if (row.kind !== 'knowledge' && (!enabled || !target.enabled))
          return { ...base, state: 'disabled' };
        const snapshot = JSON.parse(row.payload);
        let state = 'available';
        if (['knowledge', 'summary'].includes(row.kind))
          state =
            target.status === 'archived'
              ? 'archived'
              : target.revision !== snapshot.revision
                ? 'changed'
                : 'available';
        return { ...base, state, snapshot };
      });
    return {
      recorded: true,
      messageId,
      model: header.model,
      createdAt: header.created_at,
      version: header.version,
      items,
      note: '这是生成时提供给模型的参考记录，不证明模型实际采用了每一项。知识与摘要展示当时版本；近期上下文只保存消息标识和角色，不额外复制正文。删除的会话原话与摘要不再展示，关闭召回时暂时隐藏。',
    };
  }
}
