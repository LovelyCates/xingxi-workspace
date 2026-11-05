import { Fault, kinds } from './store.mjs';
import { searchTerms } from './search.mjs';

const encode = (row, stamp = 'updated_at') =>
  Buffer.from(JSON.stringify([row[stamp], row.id])).toString('base64url');
function cursor(value) {
  if (!value) return null;
  try {
    if (typeof value !== 'string' || value.length > 600) throw new Error();
    const pair = JSON.parse(Buffer.from(value, 'base64url').toString());
    if (
      !Array.isArray(pair) ||
      pair.length !== 2 ||
      pair.some((v) => typeof v !== 'string' || v.length > 200)
    )
      throw new Error();
    return pair;
  } catch {
    throw new Fault('分页游标无效');
  }
}
function page(rows, limit, stamp = 'updated_at') {
  const items = rows.slice(0, limit);
  return {
    items,
    hasMore: rows.length > limit,
    nextCursor: rows.length > limit ? encode(items.at(-1), stamp) : null,
  };
}
const summaryColumns =
  'e.id,e.space_id,e.title,substr(e.body,1,240) AS preview,e.kind,e.status,e.revision,e.created_at,e.updated_at,json_array_length(e.evidence) AS evidence_count';

export class WorkspaceViews {
  constructor(store) {
    this.store = store;
    this.db = store.db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS source_metrics(source_id TEXT PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE,body_length INTEGER NOT NULL);
      CREATE TRIGGER IF NOT EXISTS source_size_insert AFTER INSERT ON sources BEGIN INSERT INTO source_metrics VALUES(new.id,length(new.body)); END;
      CREATE TRIGGER IF NOT EXISTS source_size_update AFTER UPDATE OF body ON sources BEGIN INSERT INTO source_metrics VALUES(new.id,length(new.body)) ON CONFLICT(source_id) DO UPDATE SET body_length=excluded.body_length; END;
      CREATE TABLE IF NOT EXISTS catalog_docs(id INTEGER PRIMARY KEY AUTOINCREMENT,entry_id TEXT UNIQUE NOT NULL REFERENCES entries(id) ON DELETE CASCADE);
      CREATE VIRTUAL TABLE IF NOT EXISTS catalog_search USING fts5(scope,terms);
      CREATE TRIGGER IF NOT EXISTS catalog_delete AFTER DELETE ON catalog_docs BEGIN DELETE FROM catalog_search WHERE rowid=old.id; END;
      CREATE INDEX IF NOT EXISTS entries_counts ON entries(space_id,status,kind);
      CREATE INDEX IF NOT EXISTS entries_browse ON entries(space_id,status,updated_at DESC,id DESC);
      CREATE INDEX IF NOT EXISTS entries_timeline ON entries(space_id,updated_at DESC,id DESC);
      CREATE INDEX IF NOT EXISTS sources_browse ON sources(space_id,created_at DESC,id DESC);
      CREATE INDEX IF NOT EXISTS relations_from ON relations(space_id,from_id,id);
      CREATE INDEX IF NOT EXISTS relations_to ON relations(space_id,to_id,id);
      CREATE INDEX IF NOT EXISTS sessions_scope ON sessions(space_id);
    `);
    if (!this.db.prepare('SELECT 1 FROM migrations WHERE name=?').get('source-sizes-v1')) {
      store.transaction(() => {
        this.db.exec('INSERT OR REPLACE INTO source_metrics SELECT id,length(body) FROM sources');
        this.db.prepare('INSERT INTO migrations VALUES(?)').run('source-sizes-v1');
      });
    }
    if (!this.db.prepare('SELECT 1 FROM migrations WHERE name=?').get('catalog-search-v1')) {
      store.transaction(() => {
        for (const e of this.db.prepare('SELECT id,space_id,title,body FROM entries').iterate())
          this.index(e);
        this.db.prepare('INSERT INTO migrations VALUES(?)').run('catalog-search-v1');
      });
    }
  }
  scope(id) {
    return `space${id.replaceAll('-', '')}`;
  }
  index(e) {
    this.db.prepare('INSERT OR IGNORE INTO catalog_docs(entry_id) VALUES(?)').run(e.id);
    const doc = this.db.prepare('SELECT id FROM catalog_docs WHERE entry_id=?').get(e.id);
    this.db.prepare('DELETE FROM catalog_search WHERE rowid=?').run(doc.id);
    this.db
      .prepare('INSERT INTO catalog_search(rowid,scope,terms) VALUES(?,?,?)')
      .run(doc.id, this.scope(e.space_id), searchTerms(`${e.title} ${e.body}`, true).join(' '));
  }
  counts(spaceId) {
    const counts = { accepted: 0, pending: 0, archived: 0, kinds: [] };
    for (const row of this.db
      .prepare(
        'SELECT status,kind,count(*) AS n FROM entries WHERE space_id=? GROUP BY status,kind',
      )
      .all(spaceId)) {
      counts[row.status] += row.n;
      if (row.status === 'accepted') counts.kinds.push(row.kind);
    }
    for (const table of ['sources', 'relations', 'sessions'])
      counts[table] = this.db
        .prepare(`SELECT count(*) AS n FROM ${table} WHERE space_id=?`)
        .get(spaceId).n;
    return counts;
  }
  entries(spaceId, { q = '', filter = 'all', after, limit = 60 } = {}) {
    this.store.space(spaceId);
    if (!['all', 'pending', 'archived', ...kinds].includes(filter)) throw new Fault('筛选条件无效');
    if (typeof q !== 'string' || q.length > 2000) throw new Fault('搜索词过长');
    limit = Math.max(1, Math.min(160, Math.floor(Number(limit) || 60)));
    const status = ['pending', 'archived'].includes(filter) ? filter : 'accepted';
    const terms = searchTerms(q).slice(0, 40);
    if (q.trim() && !terms.length) return page([], limit);
    let join = '',
      where = 'e.space_id=? AND e.status=?',
      args = [spaceId, status];
    if (terms.length) {
      join =
        'JOIN catalog_docs d ON d.entry_id=e.id JOIN catalog_search ON catalog_search.rowid=d.id';
      where += ' AND catalog_search MATCH ?';
      args.push(
        `scope : "${this.scope(spaceId)}" AND terms : (${terms.map((t) => `"${t}"`).join(' AND ')})`,
      );
    }
    if (kinds.includes(filter)) {
      where += ' AND e.kind=?';
      args.push(filter);
    }
    const c = cursor(after);
    if (c) {
      where += ' AND (e.updated_at<? OR (e.updated_at=? AND e.id<?))';
      args.push(c[0], c[0], c[1]);
    }
    return page(
      this.db
        .prepare(
          `SELECT ${summaryColumns} FROM entries e ${join} WHERE ${where} ORDER BY e.updated_at DESC,e.id DESC LIMIT ?`,
        )
        .all(...args, limit + 1),
      limit,
    );
  }
  sources(spaceId, { after, limit = 50, q = '' } = {}) {
    this.store.space(spaceId);
    limit = Math.max(1, Math.min(100, Math.floor(Number(limit) || 50)));
    if (typeof q !== 'string' || q.length > 2000) throw new Fault('搜索词过长');
    const c = cursor(after),
      args = [spaceId];
    let where = 'space_id=?';
    if (q.trim()) {
      where += ' AND instr(lower(title),lower(?))>0';
      args.push(q.trim());
    }
    if (c) {
      where += ' AND (created_at<? OR (created_at=? AND id<?))';
      args.push(c[0], c[0], c[1]);
    }
    return page(
      this.db
        .prepare(
          `SELECT id,space_id,title,origin,created_at,z.body_length FROM sources JOIN source_metrics z ON z.source_id=sources.id WHERE ${where} ORDER BY created_at DESC,id DESC LIMIT ?`,
        )
        .all(...args, limit + 1),
      limit,
      'created_at',
    );
  }
  timeline(spaceId, { after, limit = 40 } = {}) {
    this.store.space(spaceId);
    limit = Math.max(1, Math.min(100, Math.floor(Number(limit) || 40)));
    const c = cursor(after),
      rows = [];
    for (const [table, stamp, type] of [
      ['sources', 'created_at', 'source'],
      ['entries', 'updated_at', 'entry'],
    ]) {
      const args = [spaceId];
      let where = 'space_id=?';
      if (c) {
        where += ` AND (${stamp}<? OR (${stamp}=? AND '${type}:'||id<?))`;
        args.push(c[0], c[0], c[1]);
      }
      const fields = type === 'entry' ? ',kind,status,revision' : '';
      rows.push(
        ...this.db
          .prepare(
            `SELECT id AS item_id,'${type}:'||id AS id,'${type}' AS type,title,${stamp} AS date${fields} FROM ${table} WHERE ${where} ORDER BY ${table}.${stamp} DESC,${table}.id DESC LIMIT ?`,
          )
          .all(...args, limit + 1),
      );
    }
    rows.sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
    return page(rows, limit, 'date');
  }
  neighbors(spaceId, id, { after } = {}) {
    this.store.entry(spaceId, id);
    if (after && (typeof after !== 'string' || after.length > 100)) throw new Fault('分页游标无效');
    const rows = this.db
      .prepare(
        `SELECT r.*,e.title AS neighbor_title,e.id AS neighbor_id,e.kind AS neighbor_kind FROM relations r JOIN entries e ON e.id=CASE WHEN r.from_id=? THEN r.to_id ELSE r.from_id END WHERE r.space_id=? AND (r.from_id=? OR r.to_id=?) AND r.id>? ORDER BY r.id LIMIT 51`,
      )
      .all(id, spaceId, id, id, after || '');
    return {
      items: rows.slice(0, 50),
      hasMore: rows.length > 50,
      nextCursor: rows.length > 50 ? rows[49].id : null,
    };
  }
  detail(spaceId, id) {
    const entry = this.store.entry(spaceId, id);
    return {
      ...entry,
      links: this.neighbors(spaceId, id),
      sourceSummaries: entry.evidence.map((ev) =>
        this.db
          .prepare(
            'SELECT id,title,origin,created_at,z.body_length FROM sources JOIN source_metrics z ON z.source_id=sources.id WHERE space_id=? AND id=?',
          )
          .get(spaceId, ev.sourceId),
      ),
    };
  }
  read(spaceId, { view = 'graph', q = '', filter = 'all', after } = {}) {
    if (!['graph', 'book', 'timeline', 'workshop', 'chat'].includes(view))
      throw new Fault('视图不存在', 404);
    const result = {
      space: this.store.space(spaceId),
      view,
      counts: this.counts(spaceId),
      entries: [],
      relations: [],
      sources: [],
      sessions: [],
      events: [],
      pages: {},
      jobs: this.db
        .prepare(
          'SELECT j.*,s.title AS source_title FROM jobs j JOIN sources s ON s.id=j.source_id WHERE j.space_id=? ORDER BY j.created_at DESC LIMIT 20',
        )
        .all(spaceId),
    };
    if (view === 'graph' || view === 'book') {
      const p = this.entries(spaceId, { q, filter, after, limit: view === 'graph' ? 160 : 60 });
      result.entries = p.items;
      result.pages.entries = { hasMore: p.hasMore, nextCursor: p.nextCursor };
      if (view === 'graph' && p.items.length) {
        const ids = p.items.map((e) => e.id),
          params = ids.map(() => '?').join(',');
        const relations = this.db
          .prepare(
            `SELECT * FROM relations WHERE space_id=? AND from_id IN (${params}) AND to_id IN (${params}) ORDER BY id LIMIT 501`,
          )
          .all(spaceId, ...ids, ...ids);
        result.relations = relations.slice(0, 500);
        result.graphEdgesTruncated = relations.length > 500;
      }
    }
    if (view === 'workshop') {
      const p = this.sources(spaceId, { after, q });
      result.sources = p.items;
      result.pages.sources = { hasMore: p.hasMore, nextCursor: p.nextCursor };
    }
    if (view === 'timeline') {
      const p = this.timeline(spaceId, { after });
      result.events = p.items;
      result.pages.events = { hasMore: p.hasMore, nextCursor: p.nextCursor };
    }
    if (view === 'chat') {
      const p = this.store.sessionList(spaceId, { before: after });
      result.sessions = p.sessions;
      result.pages.sessions = { hasMore: p.hasMore, nextCursor: p.nextBefore };
    }
    return result;
  }
}
