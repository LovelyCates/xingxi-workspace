import React, { useState, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import ReactMarkdown from 'react-markdown';
import {
  Sparkles,
  Orbit,
  BookOpen,
  CalendarDays,
  SlidersHorizontal,
  MessageCircle,
  Plus,
  ArrowUpRight,
  ArrowRight,
  Search,
  ChevronDown,
  ChevronRight,
  X,
  FileText,
  Check,
  Clock,
  Link2,
  Download,
  Send,
  Settings2,
  Layers,
  FolderOpen,
  Heart,
  Command,
  Quote,
  Pencil,
  Archive,
  Loader2,
  RefreshCw,
  ExternalLink,
  KeyRound,
  ShieldCheck,
  Upload,
  CheckCheck,
  GitBranch,
  Copy,
  Info,
} from 'lucide-react';
import Graph, { kindNames, kindColors } from './Graph';
import './style.css';
import Backups from './Backups';
import Summaries from './Summaries';

async function api(path, method = 'GET', data) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
  });
  const value = await res.json();
  if (!res.ok) throw new Error(value.error || '请求失败');
  return value;
}
const date = (d) => new Date(d).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' });
const time = (d) => new Date(d).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
const tabs = [
  ['graph', '星图', Orbit],
  ['book', '星册', BookOpen],
  ['timeline', '星历', CalendarDays],
  ['workshop', '星工坊', SlidersHorizontal],
  ['chat', '对话', MessageCircle],
];
function Markdown({ children }) {
  return (
    <ReactMarkdown
      skipHtml
      disallowedElements={['img']}
      components={{ a: (props) => <a {...props} target="_blank" rel="noreferrer" /> }}
    >
      {children}
    </ReactMarkdown>
  );
}
function Type({ kind }) {
  return (
    <span className="type" style={{ color: kindColors[kind] }}>
      <i style={{ background: kindColors[kind] }} />
      {kindNames[kind] || kind}
    </span>
  );
}
function Empty({ title, children, icon: Icon = BookOpen }) {
  return (
    <div className="empty">
      <Icon size={32} />
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}
function Modal({ title, onClose, children, wide = false }) {
  const box = useRef();
  useEffect(() => {
    const previous = document.activeElement;
    box.current?.focus();
    const key = (e) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'Tab') {
        const els = [
          ...box.current.querySelectorAll('button,input,textarea,select,a[href]'),
        ].filter((el) => !el.disabled);
        if (!els.length) {
          e.preventDefault();
          return;
        }
        if (
          e.shiftKey &&
          (document.activeElement === els[0] || document.activeElement === box.current)
        ) {
          e.preventDefault();
          els.at(-1).focus();
        } else if (!e.shiftKey && document.activeElement === els.at(-1)) {
          e.preventDefault();
          els[0].focus();
        }
      }
    };
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('keydown', key);
      previous?.focus();
    };
  }, []);
  return (
    <div className="modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <section
        ref={box}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`modal ${wide ? 'wide' : ''}`}
      >
        <header>
          <h2>{title}</h2>
          <button className="icon-button" onClick={onClose} aria-label="关闭窗口">
            <X size={20} />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}
function App() {
  const [spaces, setSpaces] = useState([]),
    [sid, setSid] = useState(''),
    [snap, setSnap] = useState(null),
    [tab, setTab] = useState('graph'),
    [selected, setSelected] = useState(null),
    [query, setQuery] = useState(''),
    [filter, setFilter] = useState('all'),
    [settings, setSettings] = useState(null),
    [modal, setModal] = useState(null),
    [editEntry, setEditEntry] = useState(null),
    [notice, setNotice] = useState(null),
    [busy, setBusy] = useState(false),
    [initialError, setInitialError] = useState(''),
    [loadedEntry, setEntry] = useState(null),
    [searchQuery, setSearchQuery] = useState(''),
    [cursorTrail, setCursorTrail] = useState([null]),
    [viewLoading, setViewLoading] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSearchQuery(query), 250);
    return () => clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    setCursorTrail([null]);
  }, [sid, tab, searchQuery, filter]);
  useEffect(() => {
    setQuery('');
    setSearchQuery('');
  }, [tab]);
  const pageHeading = useRef(null);
  const viewRequest = useRef(null),
    requestSequence = useRef(0);
  viewRequest.current = {
    sid,
    view: tab,
    q: ['graph', 'book', 'workshop'].includes(tab) ? searchQuery : '',
    filter,
    after: cursorTrail.at(-1),
  };
  const currentSid = useRef(sid);
  currentSid.current = sid;
  const notify = (text, error = false) => setNotice({ text, error });
  const reload = async (spaceId = sid) => {
    if (!spaceId || currentSid.current !== spaceId) return null;
    const request = { ...viewRequest.current },
      sequence = ++requestSequence.current;
    const params = new URLSearchParams({
      view: request.view,
      q: request.q,
      filter: request.filter,
    });
    if (request.after) params.set('after', request.after);
    setViewLoading(true);
    try {
      const data = await api(`/spaces/${spaceId}/view?${params}`);
      if (
        sequence === requestSequence.current &&
        JSON.stringify(viewRequest.current) === JSON.stringify(request)
      )
        setSnap(data);
      return data;
    } catch (error) {
      if (
        sequence === requestSequence.current &&
        JSON.stringify(viewRequest.current) === JSON.stringify(request)
      )
        throw error;
      return null;
    } finally {
      if (sequence === requestSequence.current) setViewLoading(false);
    }
  };
  useEffect(() => {
    Promise.all([api('/spaces'), api('/settings')])
      .then(([s, c]) => {
        setSpaces(s);
        setSettings(c);
        setSid(s[0]?.id || '');
      })
      .catch((e) => setInitialError(e.message));
  }, []);
  useEffect(() => {
    if (sid) {
      setSnap(null);
      setSelected(null);
      setModal(null);
      setQuery('');
      setFilter('all');
      setSearchQuery('');
    }
  }, [sid]);
  useEffect(() => {
    if (!sid) return;
    reload(sid).catch((e) => {
      if (currentSid.current === sid) notify(e.message, true);
    });
  }, [sid, tab, searchQuery, filter, cursorTrail.at(-1)]);
  useEffect(() => {
    let cancelled = false;
    if (selected && snap?.space.id === sid) {
      api(`/spaces/${sid}/entries/${selected}/detail`)
        .then((detail) => {
          if (!cancelled) setEntry(detail);
        })
        .catch((e) => {
          if (!cancelled) notify(e.message, true);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [sid, selected, snap]);
  const activeJob = snap?.jobs.some((j) => ['queued', 'running'].includes(j.status));
  useEffect(() => {
    if (!activeJob) return;
    let cancelled = false,
      timer;
    const ids = snap.jobs.filter((j) => ['queued', 'running'].includes(j.status)).map((j) => j.id);
    async function poll() {
      try {
        if (!document.hidden) {
          const jobs = await Promise.all(ids.map((id) => api(`/spaces/${sid}/jobs/${id}`)));
          if (cancelled) return;
          if (jobs.some((j) => !['queued', 'running'].includes(j.status))) await reload();
        }
      } catch (e) {
        if (!cancelled) notify(e.message, true);
      }
      if (!cancelled) timer = setTimeout(poll, 2000);
    }
    timer = setTimeout(poll, 2000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [sid, activeJob]);
  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(() => setNotice(null), 6500);
    return () => clearTimeout(id);
  }, [notice]);
  async function run(fn) {
    setBusy(true);
    try {
      return await fn();
    } catch (e) {
      notify(e.message, true);
      return null;
    } finally {
      setBusy(false);
    }
  }
  async function updateEntry(e, patch) {
    await run(async () => {
      await api(`/spaces/${sid}/entries/${e.id}`, 'PATCH', { revision: e.revision, ...patch });
      await reload();
      notify(patch.status === 'accepted' ? '已确认，这条记忆现在可以被检索。' : '已保存修改。');
    });
  }
  const entry = loadedEntry?.id === selected && loadedEntry?.space_id === sid ? loadedEntry : null;
  const space = snap?.space,
    all = snap?.entries || [],
    counts = snap?.counts || { accepted: 0, pending: 0, relations: 0, sources: 0, kinds: [] },
    visible = all;
  const currentPage =
    snap?.pages?.[
      {
        graph: 'entries',
        book: 'entries',
        workshop: 'sources',
        chat: 'sessions',
        timeline: 'events',
      }[tab]
    ];
  const pagination = (currentPage?.hasMore || cursorTrail.length > 1) && (
    <div className="page-controls">
      <button
        className="secondary"
        disabled={viewLoading || cursorTrail.length < 2}
        onClick={() => {
          setCursorTrail((c) => c.slice(0, -1));
          pageHeading.current?.scrollIntoView({ block: 'start' });
        }}
      >
        上一页
      </button>
      <span>第 {cursorTrail.length} 页 · 按需读取</span>
      <button
        className="secondary"
        disabled={viewLoading || !currentPage?.hasMore}
        onClick={() => {
          setCursorTrail((c) => [...c, currentPage.nextCursor]);
          pageHeading.current?.scrollIntoView({ block: 'start' });
        }}
      >
        下一页
      </button>
    </div>
  );
  if (initialError)
    return (
      <main className="startup">
        <Sparkles size={44} />
        <h1>暂时无法连接星汐</h1>
        <p>{initialError}</p>
        <button className="primary" onClick={() => location.reload()}>
          重新连接
        </button>
      </main>
    );
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a href="/" className="brand">
          <span className="brand-mark">✧</span>
          <div>
            <strong>
              星汐<span>Xingxi</span>
            </strong>
            <small>让知识与日常，各有归处</small>
          </div>
        </a>
        <div className="nav-section">
          <span className="eyebrow">YOUR SPACES</span>
          <button className="icon-button" onClick={() => setModal('space')} aria-label="新建空间">
            <Plus size={16} />
          </button>
        </div>
        <div className="space-list">
          {spaces.map((s) => (
            <button
              key={s.id}
              className={`space-item ${sid === s.id ? 'active' : ''}`}
              onClick={() => setSid(s.id)}
            >
              <span className={`space-icon ${s.kind}`}>
                {s.kind === 'work' ? <FolderOpen size={17} /> : <Heart size={17} />}
              </span>
              <span>
                {s.name}
                <small>{s.kind === 'work' ? '项目知识' : '陪伴记忆'}</small>
              </span>
              {sid === s.id && <span className="active-dot" />}
            </button>
          ))}
        </div>
        <div className="sidebar-divider" />
        <span className="eyebrow nav-heading">EXPLORE</span>
        <nav>
          {tabs.map(([key, label, Icon]) => (
            <button
              key={key}
              className={tab === key ? 'active' : ''}
              onClick={() => {
                setTab(key);
                setSelected(null);
                if (['graph', 'book'].includes(key)) setFilter('all');
              }}
            >
              <Icon size={19} />
              <span>{label}</span>
              {key === 'book' && counts.pending > 0 ? (
                <em>{counts.pending}</em>
              ) : tab === key ? (
                <ChevronRight size={14} />
              ) : null}
            </button>
          ))}
        </nav>
        <div className="sidebar-note">
          <span className="note-orbit">✦</span>
          <p>
            零散的灵感，
            <br />
            也会连成自己的星空。
          </p>
          <small>一颗星，一个有出处的想法。</small>
        </div>
        <div className="sidebar-footer">
          <span className="local-icon">
            <ShieldCheck size={18} />
          </span>
          <div>
            本机空间<small>资料保存在这台设备</small>
          </div>
          <span className="live-dot" />
        </div>
      </aside>
      <main className="workspace">
        <header className="topbar">
          <div className="breadcrumb">
            <span>{space?.kind === 'companion' ? '陪伴记忆' : '项目知识'}</span>
            <ChevronRight size={13} />
            <strong>{space?.name || '连接中…'}</strong>
          </div>
          <div className="topbar-right">
            <span className="local-badge">
              <span className="live-dot" />
              LOCAL FIRST
            </span>
            <button
              className="icon-button"
              aria-label="打开模型设置"
              onClick={() => setTab('workshop')}
            >
              <Settings2 size={18} />
            </button>
            <span className="avatar">汐</span>
          </div>
        </header>
        {!snap || snap.space.id !== sid || snap.view !== tab ? (
          <div className="loading">
            <Loader2 className="spin" /> 正在点亮你的星空…
          </div>
        ) : (
          <>
            <div className="mobile-space">
              <Layers size={15} />
              <select aria-label="切换空间" value={sid} onChange={(e) => setSid(e.target.value)}>
                {spaces.map((s) => (
                  <option value={s.id} key={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
              <button aria-label="新建空间" onClick={() => setModal('space')}>
                <Plus size={18} />
              </button>
              <button
                aria-label="导出星册"
                onClick={() => window.open(`/api/spaces/${sid}/export`, '_self')}
              >
                <Download size={16} />
              </button>
            </div>
            <section className="page-heading" ref={pageHeading}>
              <div>
                <div className="eyebrow">
                  {space.kind === 'companion'
                    ? 'A PLACE FOR YOUR EVERYDAY'
                    : 'A GARDEN FOR YOUR IDEAS'}
                </div>
                <h1>
                  {tabs.find((t) => t[0] === tab)?.[1]}
                  <span className="heading-spark">✧</span>
                </h1>
                <p>
                  {
                    {
                      graph: '在连接之中，看见想法的形状。',
                      book: '把值得留下的想法，写成有来处的篇章。',
                      timeline: '沿着时间，重访理解发生的时刻。',
                      workshop: '给知识一处入口，给对话一种性格。',
                      chat:
                        space.kind === 'companion'
                          ? '从上次的话题，或此刻的心情开始。'
                          : '让项目知识，参与下一次思考。',
                    }[tab]
                  }
                </p>
              </div>
              <div className="heading-actions">
                <button
                  className="secondary"
                  onClick={() => window.open(`/api/spaces/${sid}/export`, '_self')}
                >
                  <Download size={15} />
                  导出星册
                </button>
                <button className="primary" onClick={() => setModal('import')}>
                  <Plus size={17} />
                  收下一段灵感
                </button>
              </div>
            </section>
            <div className="metrics">
              <div>
                <span className="metric-icon">
                  <Sparkles size={17} />
                </span>
                <strong>{counts.accepted}</strong>
                <span>已确认记忆</span>
              </div>
              <div>
                <GitBranch size={17} />
                <strong>{counts.relations}</strong>
                <span>条思路连接</span>
              </div>
              <div>
                <FileText size={17} />
                <strong>{counts.sources}</strong>
                <span>份原始资料</span>
              </div>
              <button
                onClick={() => {
                  setTab('book');
                  setFilter('pending');
                }}
              >
                <Clock size={16} />
                <strong>{counts.pending}</strong>
                <span>条等待确认</span>
                {counts.pending > 0 && <ArrowUpRight size={14} />}
              </button>
            </div>
            {['graph', 'book'].includes(tab) && (
              <div className="content-toolbar">
                <div className="view-pills">
                  <button
                    className={filter === 'all' ? 'active' : ''}
                    onClick={() => setFilter('all')}
                  >
                    全部星光
                  </button>
                  {counts.kinds.map((k) => (
                    <button
                      className={filter === k ? 'active' : ''}
                      onClick={() => setFilter(k)}
                      key={k}
                    >
                      <span style={{ background: kindColors[k] }} />
                      {kindNames[k]}
                    </button>
                  ))}
                  {tab === 'book' && (
                    <>
                      <button
                        className={filter === 'pending' ? 'active' : ''}
                        onClick={() => setFilter('pending')}
                      >
                        待确认
                      </button>
                      <button
                        className={filter === 'archived' ? 'active' : ''}
                        onClick={() => setFilter('archived')}
                      >
                        已归档
                      </button>
                    </>
                  )}
                </div>
                <label className="search">
                  <Search size={15} />
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="寻找一个想法…"
                    aria-label="搜索记忆"
                    maxLength={2000}
                  />
                  <kbd>⌕</kbd>
                </label>
              </div>
            )}
            {tab === 'graph' && (
              <div className={`graph-layout ${entry ? 'with-detail' : ''}`}>
                <div className="graph-card">
                  <Graph
                    paged={currentPage?.hasMore || cursorTrail.length > 1}
                    entries={visible}
                    relations={snap.relations}
                    onSelect={(e) => setSelected(e.id)}
                    selected={selected}
                  />
                  <div className="graph-footer">
                    <span>
                      <Layers size={14} /> {space.name}
                    </span>
                    <span>
                      {snap.graphEdgesTruncated
                        ? '本组连接较多，展示前 500 条；可筛选缩小范围'
                        : '只展示当前空间的记忆与连接'}
                    </span>
                  </div>
                </div>
                {entry && (
                  <EntryDetail
                    entry={entry}
                    sources={entry.sourceSummaries}
                    links={entry.links}
                    sid={sid}
                    onClose={() => setSelected(null)}
                    onEdit={() => {
                      setEditEntry(entry);
                      setModal('edit');
                    }}
                    onUpdate={updateEntry}
                    onReload={reload}
                    busy={busy}
                    notify={notify}
                  />
                )}
              </div>
            )}
            {tab === 'book' && (
              <div className={`book-layout ${entry ? 'with-detail' : ''}`}>
                <div className="entry-grid">
                  {visible.map((e) => (
                    <button
                      className={`entry-card ${selected === e.id ? 'chosen' : ''}`}
                      onClick={() => setSelected(e.id)}
                      key={e.id}
                    >
                      <div>
                        <Type kind={e.kind} />
                        <ArrowUpRight size={15} />
                      </div>
                      <h3>{e.title}</h3>
                      <p>{e.preview}</p>
                      <footer>
                        <span>
                          <Link2 size={12} />
                          {e.evidence_count} 个出处
                        </span>
                        <span>{date(e.updated_at)}</span>
                      </footer>
                    </button>
                  ))}
                  {!visible.length && (
                    <Empty title="这里还留着空白">导入资料，或切换筛选条件，寻找下一颗星。</Empty>
                  )}
                </div>
                {entry && (
                  <EntryDetail
                    entry={entry}
                    sources={entry.sourceSummaries}
                    links={entry.links}
                    sid={sid}
                    onClose={() => setSelected(null)}
                    onEdit={() => {
                      setEditEntry(entry);
                      setModal('edit');
                    }}
                    onUpdate={updateEntry}
                    onReload={reload}
                    busy={busy}
                    notify={notify}
                  />
                )}
              </div>
            )}
            {tab === 'timeline' && (
              <Timeline
                snap={snap}
                onSelect={(e) => {
                  setTab('book');
                  setFilter(e.status === 'accepted' ? 'all' : e.status);
                  setSelected(e.id);
                }}
              />
            )}
            {tab === 'workshop' && (
              <Workshop
                query={query}
                setQuery={setQuery}
                snap={snap}
                settings={settings}
                setSettings={setSettings}
                api={api}
                reload={reload}
                run={run}
                busy={busy}
                notify={notify}
                onImport={() => setModal('import')}
                onReview={() => {
                  setTab('book');
                  setFilter('pending');
                }}
              />
            )}
            {tab === 'chat' && (
              <Chat
                key={sid}
                sid={sid}
                snap={snap}
                configured={settings?.configured}
                notify={notify}
                reload={reload}
                onSettings={() => setTab('workshop')}
              />
            )}
            {viewLoading && (
              <p role="status" className="form-note">
                正在读取当前页…
              </p>
            )}
            {pagination}
            <footer className="page-footer">
              <span>
                XINGXI <i>·</i> 思绪有迹，日常有光。
              </span>
              <a href="https://github.com/Yuuyuko-uu/dsh-xingxi" target="_blank" rel="noreferrer">
                视觉派生自 星汐 · Yuuyuko-uu <ExternalLink size={11} />
              </a>
            </footer>
          </>
        )}
      </main>
      {notice && (
        <div
          className={`toast ${notice.error ? 'error' : ''}`}
          role={notice.error ? 'alert' : 'status'}
        >
          {notice.error ? <Info size={18} /> : <Check size={18} />}
          <span>{notice.text}</span>
          <button onClick={() => setNotice(null)} aria-label="关闭提示">
            <X size={16} />
          </button>
        </div>
      )}
      {modal === 'space' && (
        <Modal title="留一片新的星空" onClose={() => setModal(null)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const form = new FormData(e.currentTarget);
              run(async () => {
                const s = await api('/spaces', 'POST', Object.fromEntries(form));
                setSpaces(await api('/spaces'));
                setSid(s.id);
                setTab('graph');
                setModal(null);
              });
            }}
          >
            <label>
              空间名称
              <input name="name" placeholder="例如：我的新项目" required maxLength={60} />
            </label>
            <label>
              空间类型
              <select name="kind">
                <option value="work">项目知识 · 工作 Wiki</option>
                <option value="companion">陪伴记忆 · 日常对话</option>
              </select>
            </label>
            <label>
              留一句介绍
              <textarea name="description" placeholder="这里要收下什么？" maxLength={400} />
            </label>
            <p className="form-note">新空间从空白开始，资料和检索各自独立。</p>
            <button className="primary full" disabled={busy}>
              创建空间 <ArrowRight size={16} />
            </button>
          </form>
        </Modal>
      )}
      {modal === 'import' && (
        <ImportModal
          sid={sid}
          onClose={() => setModal(null)}
          onSave={async () => {
            await reload();
            notify('资料已收好，可以在工坊提炼或手动整理。');
            setModal(null);
            setTab('workshop');
          }}
        />
      )}
      {modal === 'edit' && editEntry && (
        <Modal title="编辑这颗星" onClose={() => setModal(null)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const f = Object.fromEntries(new FormData(e.currentTarget));
              run(async () => {
                await api(`/spaces/${sid}/entries/${editEntry.id}`, 'PATCH', {
                  ...f,
                  revision: editEntry.revision,
                });
                await reload();
                setModal(null);
                notify('新版本已保存，旧版本仍可查看。');
              });
            }}
          >
            <label>
              标题
              <input name="title" defaultValue={editEntry.title} required maxLength={160} />
            </label>
            <label>
              正文
              <textarea
                className="large-input"
                name="body"
                defaultValue={editEntry.body}
                required
                maxLength={20000}
              />
            </label>
            <p className="form-note">原始资料保持不变。编辑后的解释应继续符合来源。</p>
            <button className="primary full" disabled={busy}>
              保存为新版本
            </button>
          </form>
        </Modal>
      )}
    </div>
  );
}

function EntryDetail({
  entry: e,
  sources,
  links,
  sid,
  onClose,
  onEdit,
  onUpdate,
  onReload,
  busy,
  notify,
}) {
  const [history, setHistory] = useState(null),
    [source, setSource] = useState(null),
    [relate, setRelate] = useState(false),
    [relBusy, setRelBusy] = useState(false),
    [neighbors, setNeighbors] = useState(links),
    [picker, setPicker] = useState({ items: [], hasMore: false }),
    [pickerQuery, setPickerQuery] = useState(''),
    [pickerBusy, setPickerBusy] = useState(false);
  useEffect(() => setNeighbors(links), [links]);
  useEffect(() => {
    if (!relate) return;
    setPickerBusy(true);
    let cancelled = false;
    const timer = setTimeout(async () => {
      setPickerBusy(true);
      try {
        const result = await api(`/spaces/${sid}/entries?q=${encodeURIComponent(pickerQuery)}`);
        if (!cancelled) setPicker(result);
      } catch (error) {
        if (!cancelled) notify(error.message, true);
      } finally {
        if (!cancelled) setPickerBusy(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [relate, pickerQuery, sid]);
  useEffect(() => {
    setHistory(null);
    setSource(null);
  }, [e.id, e.revision]);
  return (
    <aside className="detail-panel">
      <header>
        <span className="eyebrow">A CLOSER LOOK</span>
        <button className="icon-button" onClick={onClose} aria-label="关闭记忆详情">
          <X size={17} />
        </button>
      </header>
      <Type kind={e.kind} />
      <h2>{e.title}</h2>
      <div className="entry-meta">
        {date(e.updated_at)} · 版本 {e.revision} ·{' '}
        {e.status === 'accepted' ? '已确认' : e.status === 'pending' ? '待确认' : '已归档'}
      </div>
      <div className="markdown">
        <Markdown>{e.body}</Markdown>
      </div>
      <div className="section-label">
        <Link2 size={14} />
        这份记忆从哪里来
      </div>
      {e.evidence.map((ev, i) => {
        const s = sources.find((s) => s.id === ev.sourceId);
        return (
          <button
            className="evidence-card"
            key={i}
            onClick={async () => {
              try {
                setSource(await api(`/spaces/${sid}/sources/${ev.sourceId}`));
              } catch (err) {
                notify(err.message, true);
              }
            }}
          >
            <Quote size={16} />
            <p>{ev.quote}</p>
            <span>
              {s?.title || '来源'} <ArrowUpRight size={12} />
            </span>
          </button>
        );
      })}
      <div className="section-label">
        <GitBranch size={14} />
        相邻的想法
      </div>
      <div className="related-list">
        {neighbors.items.map((r) => (
          <div key={r.id}>
            <span>{r.label}</span>
            {r.neighbor_title}
          </div>
        ))}
        {neighbors.hasMore && (
          <button
            className="text-button"
            disabled={relBusy}
            onClick={async () => {
              setRelBusy(true);
              try {
                const next = await api(
                  `/spaces/${sid}/entries/${e.id}/neighbors?after=${encodeURIComponent(neighbors.nextCursor)}`,
                );
                setNeighbors((n) => ({ ...next, items: [...n.items, ...next.items] }));
              } catch (error) {
                notify(error.message, true);
              } finally {
                setRelBusy(false);
              }
            }}
          >
            加载更多连接
          </button>
        )}
        <button className="text-button" onClick={() => setRelate(true)}>
          <Plus size={13} />
          添加连接
        </button>
      </div>
      <div className="detail-actions">
        {e.status === 'pending' && (
          <button
            className="primary"
            disabled={busy}
            onClick={() => onUpdate(e, { status: 'accepted' })}
          >
            <Check size={15} />
            确认记忆
          </button>
        )}
        <button className="secondary" onClick={onEdit}>
          <Pencil size={14} />
          编辑
        </button>
        <button
          className="secondary"
          disabled={busy}
          onClick={() => onUpdate(e, { status: e.status === 'archived' ? 'pending' : 'archived' })}
        >
          <Archive size={14} />
          {e.status === 'archived' ? '移回待确认' : '归档'}
        </button>
      </div>
      <button
        className="text-button history-toggle"
        onClick={async () => {
          try {
            setHistory(history ? null : await api(`/spaces/${sid}/entries/${e.id}/history`));
          } catch (err) {
            notify(err.message, true);
          }
        }}
      >
        <Clock size={13} />
        {history ? '收起修订记录' : '查看修订记录'}
      </button>
      {history && (
        <div className="history-list">
          {history.length ? (
            history.map((r) => (
              <div key={r.revision}>
                <small>
                  版本 {r.revision} · {date(r.created_at)}
                </small>
                <strong>{r.snapshot.title}</strong>
                <p>{r.snapshot.body}</p>
              </div>
            ))
          ) : (
            <p>还没有历史修订。</p>
          )}
        </div>
      )}
      {source && (
        <Modal title={source.title} onClose={() => setSource(null)} wide>
          <span className="source-origin">
            原始资料 · {source.origin} · {date(source.created_at)}
          </span>
          <div className="source-text">{source.body}</div>
        </Modal>
      )}
      {relate && (
        <Modal title="连起两个想法" onClose={() => setRelate(false)}>
          <form
            onSubmit={async (ev) => {
              ev.preventDefault();
              setRelBusy(true);
              try {
                await api(`/spaces/${sid}/relations`, 'POST', {
                  fromId: e.id,
                  ...Object.fromEntries(new FormData(ev.currentTarget)),
                });
                setRelate(false);
                await onReload();
                notify('连接已建立。');
              } catch (err) {
                notify(err.message, true);
              } finally {
                setRelBusy(false);
              }
            }}
          >
            <label>
              关系
              <input name="label" placeholder="例如：支持、依赖、修正" required maxLength={30} />
            </label>
            <label>
              搜索要连接的知识
              <input
                value={pickerQuery}
                maxLength={2000}
                onChange={(event) => setPickerQuery(event.target.value)}
                placeholder="标题或正文关键词"
              />
            </label>
            <label>
              连接到
              <select name="toId" required disabled={pickerBusy}>
                {picker.items
                  .filter((x) => x.id !== e.id && x.status === 'accepted')
                  .map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.title}
                    </option>
                  ))}
              </select>
            </label>
            {picker.hasMore && (
              <button
                className="text-button"
                type="button"
                disabled={pickerBusy}
                onClick={async () => {
                  setPickerBusy(true);
                  try {
                    setPicker(
                      await api(
                        `/spaces/${sid}/entries?q=${encodeURIComponent(pickerQuery)}&after=${encodeURIComponent(picker.nextCursor)}`,
                      ),
                    );
                  } catch (error) {
                    notify(error.message, true);
                  } finally {
                    setPickerBusy(false);
                  }
                }}
              >
                下一组可连接的知识
              </button>
            )}
            <button
              disabled={
                relBusy ||
                pickerBusy ||
                picker.items.filter((x) => x.id !== e.id && x.status === 'accepted').length === 0
              }
              className="primary full"
            >
              建立连接
            </button>
          </form>
        </Modal>
      )}
    </aside>
  );
}

function ImportModal({ sid, onClose, onSave }) {
  const [title, setTitle] = useState(''),
    [body, setBody] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  return (
    <Modal title="收下一段灵感" onClose={onClose} wide>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            await api(`/spaces/${sid}/sources`, 'POST', { title, body });
            await onSave();
          } catch (err) {
            setError(err.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <p className="form-intro">贴入一段项目资料、讨论记录或日常片段。星汐会保留这份原文。</p>
        <label>
          给资料起个名字
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="例如：今天的产品讨论"
            required
            maxLength={160}
          />
        </label>
        <label>
          原始内容
          <textarea
            className="large-input"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            placeholder="从一个想法开始…"
            required
            maxLength={100000}
          />
        </label>
        <div className="import-bottom">
          <label className="file-picker">
            <Upload size={15} />
            读取 .md / .txt
            <input
              type="file"
              accept=".md,.txt,text/plain,text/markdown"
              onChange={async (e) => {
                const f = e.target.files[0];
                if (!f) return;
                if (f.size > 300000) {
                  setError('文件过大，请选取较短的资料。');
                  return;
                }
                setBody(await f.text());
                if (!title) setTitle(f.name.replace(/\.(md|txt)$/, ''));
              }}
            />
          </label>
          <span>{body.length.toLocaleString()} 字符</span>
        </div>
        {error && (
          <p className="inline-error" role="alert">
            {error}
          </p>
        )}
        <button disabled={busy} className="primary full">
          {busy ? <Loader2 size={16} className="spin" /> : <Plus size={16} />}保存原始资料
        </button>
      </form>
    </Modal>
  );
}

function Timeline({ snap, onSelect }) {
  const events = snap.events.map((event) => ({
    ...event,
    item: { ...event, id: event.item_id },
    subtitle:
      event.type === 'source'
        ? '收下了一份原始资料'
        : event.revision > 1
          ? `记忆已更新至版本 ${event.revision}`
          : '一颗新的记忆',
  }));
  return (
    <div className="timeline-layout">
      <section className="timeline">
        <div className="timeline-title">
          <CalendarDays size={18} />
          <h2>那些思绪留下的轨迹</h2>
          <span>本页 {events.length} 个时刻</span>
        </div>
        {!events.length && (
          <Empty title="故事从这里开始">收下第一份资料，就会留下时间的印记。</Empty>
        )}
        {events.map((e, i) => (
          <React.Fragment key={e.id}>
            {(i === 0 || date(events[i - 1].date) !== date(e.date)) && (
              <h3 className="date-heading">
                {date(e.date)} <small>{new Date(e.date).getFullYear()}</small>
              </h3>
            )}
            <button
              className="timeline-event"
              onClick={() => e.type === 'entry' && onSelect(e.item)}
              disabled={e.type === 'source'}
            >
              <span className={`timeline-dot ${e.type}`}>
                {e.type === 'source' ? <FileText size={14} /> : <Sparkles size={14} />}
              </span>
              <time>{time(e.date)}</time>
              <div>
                <span>{e.subtitle}</span>
                <strong>{e.title}</strong>
              </div>
              {e.type === 'entry' && <Type kind={e.item.kind} />}
            </button>
          </React.Fragment>
        ))}
      </section>
      <aside className="quiet-card">
        <span className="big-star">✧</span>
        <h3>
          知识会生长，
          <br />
          也允许改变。
        </h3>
        <p>星历展示资料的加入与记忆的最近更新。打开一条记忆，还能回看每个旧版本。</p>
        <div>
          <Clock size={15} />
          每一次修订，都有迹可循。
        </div>
      </aside>
    </div>
  );
}

function Workshop({
  query,
  setQuery,
  snap,
  settings,
  setSettings,
  reload,
  run,
  busy,
  notify,
  onImport,
  onReview,
}) {
  const [manual, setManual] = useState(null),
    [sourceView, setSourceView] = useState(null),
    [key, setKey] = useState('');
  const sid = snap.space.id;
  const config = JSON.stringify(
    {
      mcpServers: {
        xingxi: { command: 'node', args: ['/absolute/path/to/xingxi-workspace/server/mcp.mjs'] },
      },
    },
    null,
    2,
  );
  return (
    <div className="workshop-grid">
      <section className="panel sources-panel">
        <div className="panel-heading">
          <div>
            <span className="eyebrow">COLLECT & CULTIVATE</span>
            <h2>灵感入口</h2>
          </div>
          <button className="secondary" onClick={onImport}>
            <Plus size={14} />
            导入
          </button>
        </div>
        <p className="panel-desc">资料 → 提炼候选 → 你来确认 → 加入记忆</p>
        <label>
          按标题查找资料
          <input
            value={query}
            maxLength={2000}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索整个空间的资料标题"
          />
        </label>
        {!snap.sources.length && (
          <Empty title={snap.counts.sources ? '没有匹配的资料' : '还没有资料'}>
            {snap.counts.sources
              ? '试试其他标题关键词，或清空搜索。'
              : '一段文字、一份笔记，都可以作为起点。'}
          </Empty>
        )}
        <div className="source-list">
          {snap.sources.map((s) => (
            <div className="source-row" key={s.id}>
              <button
                className="source-name"
                onClick={() =>
                  run(async () => setSourceView(await api(`/spaces/${sid}/sources/${s.id}`)))
                }
              >
                <span className="file-icon">
                  <FileText size={20} />
                </span>
                <div>
                  <strong>{s.title}</strong>
                  <small>
                    {s.body_length.toLocaleString()} 字符 · {date(s.created_at)}
                    {s.origin === 'example' ? ' · 虚构示例' : ''}
                  </small>
                </div>
              </button>
              <div>
                <button
                  className="text-button"
                  onClick={() =>
                    run(async () => setManual(await api(`/spaces/${sid}/sources/${s.id}`)))
                  }
                >
                  手动整理
                </button>
                <button
                  className="small-button"
                  disabled={
                    busy ||
                    snap.jobs.some(
                      (j) => j.source_id === s.id && ['queued', 'running'].includes(j.status),
                    )
                  }
                  onClick={() =>
                    run(async () => {
                      await api(`/spaces/${sid}/compile`, 'POST', { sourceId: s.id });
                      await reload();
                      notify('提炼任务已提交，完成后请检查候选内容。');
                    })
                  }
                >
                  <Sparkles size={13} />
                  提炼
                </button>
              </div>
            </div>
          ))}
        </div>
        <div className="candidate-banner">
          <span>
            <Layers size={18} />
            {snap.counts.pending} 条候选等待你的确认
          </span>
          <button onClick={onReview}>
            去看看 <ArrowRight size={14} />
          </button>
        </div>
        {snap.jobs.length > 0 && (
          <div className="job-list">
            {snap.jobs.slice(0, 4).map((j) => (
              <div key={j.id}>
                <span className={`job-dot ${j.status}`} />
                <span>{j.source_title}</span>
                <strong>
                  {
                    { queued: '等待中', running: '提炼中', done: '已完成', failed: '未完成' }[
                      j.status
                    ]
                  }
                </strong>
                {j.error && <p>{j.error}</p>}
              </div>
            ))}
          </div>
        )}
      </section>
      <section className="panel model-panel">
        <div className="panel-heading">
          <div>
            <span className="eyebrow">MODEL CONNECTION</span>
            <h2>连接 DeepSeek</h2>
          </div>
          <KeyRound size={20} />
        </div>
        <div className={`connection-status ${settings?.configured ? 'connected' : ''}`}>
          <span className="live-dot" />
          {settings?.configured ? 'Key 已保存在本机' : '等待连接模型'}
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const model = new FormData(e.currentTarget).get('model');
            run(async () => {
              const s = await api('/settings', 'PUT', { ...(key ? { key } : {}), model });
              setSettings(s);
              setKey('');
              notify('模型设置已保存。');
            });
          }}
        >
          <label>
            模型
            <select name="model" defaultValue={settings?.model}>
              <option value="deepseek-flash">DeepSeek Flash</option>
              <option value="deepseek-v4-pro">DeepSeek V4 Pro</option>
            </select>
          </label>
          <label>
            API Key
            <input
              type="password"
              autoComplete="new-password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={settings?.configured ? '已配置 · 留空保持原 Key' : 'sk-…'}
            />
          </label>
          <p className="form-note">
            仅在提炼和对话时向 DeepSeek 发送必要内容。Key 保存在本机，不会写入项目仓库。
          </p>
          <div className="button-row">
            <button className="primary" disabled={busy}>
              保存连接
            </button>
            {settings?.configured && (
              <button
                className="text-button"
                type="button"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    setSettings(await api('/settings', 'PUT', { key: '' }));
                    notify('本机 Key 已清除。');
                  })
                }
              >
                清除 Key
              </button>
            )}
          </div>
        </form>
      </section>
      <section className="panel persona-panel">
        <div className="panel-heading">
          <div>
            <span className="eyebrow">A FAMILIAR VOICE</span>
            <h2>{snap.space.kind === 'companion' ? '对话的温度' : '项目伙伴的表达'}</h2>
          </div>
          <MessageCircle size={20} />
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const form = new FormData(e.currentTarget);
            const persona = form.get('persona');
            const recallEnabled = form.get('recallEnabled') === 'on';
            run(async () => {
              await api(`/spaces/${sid}`, 'PATCH', { persona, recallEnabled });
              await reload();
              notify('对话设定已更新，下次回复生效。');
            });
          }}
        >
          <label>
            它会怎样与你说话
            <textarea
              name="persona"
              key={sid}
              defaultValue={snap.space.persona}
              maxLength={4000}
              required
            />
          </label>
          <label className="memory-toggle">
            <input type="checkbox" name="recallEnabled" defaultChecked={snap.space.recallEnabled} />
            自动延续同空间聊天
          </label>
          <p className="form-note">
            本机检索历史用户原话与已审阅摘要，网页和 MCP
            共用。关闭后不再召回这些历史片段与摘要；当前会话近期消息和已确认知识仍可用于回答。原话不会自动变成正式知识，摘要需要先审阅。
          </p>
          <div className="persona-hints">
            <span>
              <Check size={12} />
              记住已确认的偏好
            </span>
            <span>
              <Check size={12} />
              延续最近的话题
            </span>
            <span>
              <Check size={12} />
              保留同一段会话
            </span>
          </div>
          <button className="secondary" disabled={busy}>
            保存对话设定
          </button>
        </form>
      </section>
      <section className="panel mcp-panel">
        <div className="panel-heading">
          <div>
            <span className="eyebrow">OPEN TO YOUR AGENTS</span>
            <h2>让其他 Agent 接上来</h2>
          </div>
          <Command size={21} />
        </div>
        <p className="panel-desc">通过 MCP 检索知识、提交资料，或调用星汐继续同一段对话。</p>
        <div className="tool-chips">
          <code>context_get</code>
          <code>wiki_ingest</code>
          <code>chat_reply</code>
        </div>
        <pre>{config}</pre>
        <p className="form-note">
          将路径替换为本项目的实际绝对路径，并先启动星汐服务。配套技能见{' '}
          <code>skills/xingxi/SKILL.md</code>。
        </p>
        <button
          className="secondary"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(config);
              notify('MCP 配置模板已复制，请替换路径。');
            } catch {
              notify('复制失败，请手动选中配置文本。', true);
            }
          }}
        >
          <Copy size={14} />
          复制配置模板
        </button>
      </section>
      <Backups api={api} notify={notify} />
      {sourceView && (
        <Modal title={sourceView.title} onClose={() => setSourceView(null)} wide>
          <div className="source-text">{sourceView.body}</div>
        </Modal>
      )}
      {manual && (
        <Modal title="整理成一条记忆" onClose={() => setManual(null)} wide>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const f = Object.fromEntries(new FormData(e.currentTarget));
              run(async () => {
                await api(`/spaces/${sid}/entries`, 'POST', {
                  title: f.title,
                  kind: f.kind,
                  body: f.body,
                  evidence: [{ sourceId: manual.id, quote: f.quote }],
                });
                await reload();
                setManual(null);
                notify('已加入候选，检查后即可确认。');
              });
            }}
          >
            <label>
              原文参考<div className="quote-reference">{manual.body}</div>
            </label>
            <div className="form-columns">
              <label>
                标题
                <input name="title" required maxLength={160} />
              </label>
              <label>
                类型
                <select name="kind">
                  {Object.entries(kindNames).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label>
              这条记忆是什么
              <textarea name="body" required maxLength={20000} />
            </label>
            <label>
              复制一段原文作为依据
              <textarea
                name="quote"
                placeholder="必须是上方原文中连续的一段文字"
                required
                maxLength={5000}
              />
            </label>
            <button className="primary full" disabled={busy}>
              保存到待确认
            </button>
          </form>
        </Modal>
      )}
    </div>
  );
}

function ReplyEvidenceView({ sid, sessionId, messageId, onClose, onConversation, canNavigate }) {
  const [data, setData] = useState(null),
    [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError('');
    api(`/spaces/${sid}/sessions/${sessionId}/messages/${messageId}/evidence`)
      .then((result) => {
        if (!cancelled) setData(result);
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [sid, sessionId, messageId]);
  const recalled = data?.items.filter((item) => item.kind !== 'recent') || [];
  const recent = data?.items.filter((item) => item.kind === 'recent') || [];
  const labels = {
    deleted: '原始记录已删除，摘录已清理',
    disabled: '该会话已关闭召回，暂不展示',
    changed: '内容已更新，以下为当时版本',
    archived: '内容已归档，以下为当时版本',
  };
  return (
    <Modal title="这次回答的参考记录" onClose={onClose} wide>
      {error ? (
        <p role="alert">{error}</p>
      ) : !data ? (
        <p>读取参考记录…</p>
      ) : (
        <>
          <p className="form-note">{data.note}</p>
          {data.recorded && (
            <>
              <p className="form-note">
                {data.model} · {date(data.createdAt)} {time(data.createdAt)}
              </p>
              <h3>检索出的知识、原话与摘要 · {recalled.length}</h3>
              {!recalled.length && <p>本轮没有额外召回知识、历史原话或摘要。</p>}
              {recalled.map((item) => (
                <blockquote className="memory-excerpt" key={`${item.kind}:${item.ordinal}`}>
                  <small>
                    {item.kind === 'knowledge'
                      ? '已确认知识'
                      : item.kind === 'summary'
                        ? '已审阅会话摘要'
                        : '历史用户原话'}
                    {labels[item.state] ? ` · ${labels[item.state]}` : ''}
                  </small>
                  {item.snapshot &&
                    (item.kind === 'knowledge' ? (
                      <>
                        <h4>
                          {item.snapshot.title} · 版本 {item.snapshot.revision}
                        </h4>
                        <p>{item.snapshot.body}</p>
                        <details>
                          <summary>当时提供的来源摘录</summary>
                          {item.snapshot.sources.map((source, index) => (
                            <p key={index}>
                              {source.quote}
                              <small> · {source.origin}</small>
                            </p>
                          ))}
                        </details>
                      </>
                    ) : item.kind === 'summary' ? (
                      <>
                        <h4>
                          {item.snapshot.title} ·{' '}
                          {item.snapshot.role === 'user' ? '用户表达' : '助手建议或回答'} · 版本{' '}
                          {item.snapshot.revision}
                        </h4>
                        <p>{item.snapshot.body}</p>
                        <small>
                          原会话：{item.snapshot.session_title}。这是摘要，不是逐字原话。
                        </small>
                        {item.snapshot.truncated && <small> 模型收到的是有长度限制的摘要。</small>}
                        <details>
                          <summary>当时提供的原话依据</summary>
                          {item.snapshot.evidence.map((ev, index) => (
                            <p key={index}>
                              {ev.quote}
                              <small>
                                {' '}
                                · {date(ev.created_at)} {time(ev.created_at)}
                                {ev.truncated ? ' · 片段' : ''}
                              </small>
                            </p>
                          ))}
                        </details>
                        <button
                          className="text-button"
                          disabled={!canNavigate}
                          onClick={() => onConversation(item.snapshot.session_id)}
                        >
                          打开原会话
                        </button>
                      </>
                    ) : (
                      <>
                        <h4>
                          {item.snapshot.session_title} · {date(item.snapshot.created_at)}
                        </h4>
                        <p>{item.snapshot.quote}</p>
                        {item.snapshot.truncated && <small>模型收到的是原话片段。</small>}
                        <button
                          className="text-button"
                          disabled={!canNavigate}
                          onClick={() => onConversation(item.snapshot.session_id)}
                        >
                          打开原会话
                        </button>
                      </>
                    ))}
                </blockquote>
              ))}
              <h3>近期上下文 · {recent.length} 条</h3>
              <p className="form-note">
                这部分来自当前会话。记录只保存消息标识、角色和时间，正文仍在原会话。
              </p>
              <details>
                <summary>查看上下文顺序</summary>
                <ol>
                  {recent.map((item) => (
                    <li key={item.ordinal}>
                      {item.snapshot
                        ? `${item.snapshot.role === 'user' ? '用户' : '星汐'} · ${date(item.snapshot.created_at)} ${time(item.snapshot.created_at)}`
                        : labels[item.state]}
                    </li>
                  ))}
                </ol>
              </details>
            </>
          )}
        </>
      )}
    </Modal>
  );
}

function Chat({ sid, snap, configured, notify, reload, onSettings }) {
  const [session, setSession] = useState(null),
    [draft, setDraft] = useState(''),
    [sending, setSending] = useState(false),
    [loading, setLoading] = useState(true),
    [retry, setRetry] = useState(null),
    [loadingOlder, setLoadingOlder] = useState(false),
    [memoryView, setMemoryView] = useState(null),
    [memoryQuery, setMemoryQuery] = useState(''),
    [deleting, setDeleting] = useState(false),
    [changingMemory, setChangingMemory] = useState(false),
    [deleteOpen, setDeleteOpen] = useState(false),
    [evidenceId, setEvidenceId] = useState(null),
    [summaryOpen, setSummaryOpen] = useState(false);
  const bottom = useRef(),
    preserveScroll = useRef(false);
  async function load(id) {
    setLoading(true);
    try {
      setSession(await api(`/spaces/${sid}/sessions/${id}`));
      setRetry(null);
      setEvidenceId(null);
      localStorage.setItem(`xingxi.session.${sid}`, id);
    } catch (e) {
      notify(e.message, true);
      localStorage.removeItem(`xingxi.session.${sid}`);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    const saved = localStorage.getItem(`xingxi.session.${sid}`);
    const id = saved || snap.sessions[0]?.id;
    if (id) load(id);
    else setLoading(false);
  }, []);
  useEffect(() => {
    if (preserveScroll.current) {
      preserveScroll.current = false;
      return;
    }
    bottom.current?.scrollIntoView({ behavior: 'instant', block: 'nearest' });
  }, [session?.messages.length, sending]);
  async function send(payload) {
    if (!payload.body.trim() || sending || loading || loadingOlder || deleting || changingMemory)
      return;
    setSending(true);
    let s = session;
    try {
      if (!s) {
        s = await api(`/spaces/${sid}/sessions`, 'POST', { title: payload.body.slice(0, 30) });
        setSession(s);
        await reload();
      }
      setDraft('');
      setRetry(null);
      setEvidenceId(null);
      if (!s.messages.some((m) => m.client_id === payload.clientId)) {
        setSession({
          ...s,
          messages: [
            ...s.messages,
            {
              id: `pending:${payload.clientId}`,
              client_id: payload.clientId,
              role: 'user',
              body: payload.body,
              created_at: new Date().toISOString(),
            },
          ],
        });
      }
      const result = await api(`/spaces/${sid}/sessions/${s.id}/reply`, 'POST', payload);
      setSession(result.session);
      localStorage.setItem(`xingxi.session.${sid}`, s.id);
    } catch (e) {
      notify(e.message, true);
      setRetry(payload);
      if (s) setSession(await api(`/spaces/${sid}/sessions/${s.id}`).catch(() => s));
    } finally {
      setSending(false);
    }
  }
  async function showMemories(query = '') {
    try {
      setMemoryView(
        await api(`/spaces/${sid}/conversation-context?q=${encodeURIComponent(query)}`),
      );
    } catch (e) {
      notify(e.message, true);
    }
  }
  async function archiveConversation() {
    try {
      await api(`/spaces/${sid}/sessions/${session.id}/source`, 'POST', {});
      await reload();
      notify('对话已保存为资料，可到工坊提炼或手动整理。');
    } catch (e) {
      notify(e.message, true);
    }
  }
  return (
    <div className="chat-layout">
      <aside className="session-list">
        <div>
          <span className="eyebrow">CONVERSATIONS</span>
          <button
            className="icon-button"
            aria-label="新建对话"
            disabled={sending || loading || loadingOlder || deleting || changingMemory}
            onClick={() => {
              setSession(null);
              setRetry(null);
              setDraft('');
              setEvidenceId(null);
            }}
          >
            <Plus size={16} />
          </button>
        </div>
        {snap.sessions.map((s) => (
          <button
            key={s.id}
            disabled={sending || loading || loadingOlder || deleting || changingMemory}
            className={s.id === session?.id ? 'active' : ''}
            onClick={() => load(s.id)}
          >
            <MessageCircle size={15} />
            <span>{s.title}</span>
          </button>
        ))}
        {!snap.sessions.length && (
          <p>
            每次对话，
            <br />
            都从一句话开始。
          </p>
        )}
        <div className="session-note">
          <ShieldCheck size={15} />
          {snap.space.recallEnabled ? '同空间聊天记忆已开启' : '历史聊天召回已关闭'}
        </div>
      </aside>
      <section className="chat-panel">
        <header>
          <span className="chat-avatar">✧</span>
          <div>
            <strong>
              {snap.space.kind === 'companion' ? '星汐 · 日常陪伴' : '星汐 · 项目伙伴'}
            </strong>
            <small>{session ? '这段对话会被保留下来' : '一个新的开始'}</small>
          </div>
          <button
            className="text-button"
            onClick={() => {
              setMemoryQuery('');
              showMemories();
            }}
          >
            聊天记忆
          </button>
          {session && (
            <button
              className="text-button"
              disabled={sending || loading || deleting}
              onClick={() => setSummaryOpen(true)}
            >
              会话摘要
            </button>
          )}
          {session && (
            <button
              className="text-button"
              disabled={sending || loadingOlder || changingMemory}
              onClick={() => setDeleteOpen(true)}
            >
              删除会话
            </button>
          )}
          {session?.messages.length > 0 && (
            <button className="text-button" disabled={sending} onClick={archiveConversation}>
              <BookOpen size={14} />
              收为资料
            </button>
          )}
        </header>
        {session && (
          <div className="chat-memory-status">
            <label>
              <input
                type="checkbox"
                checked={session.recallEnabled}
                disabled={sending || changingMemory || deleting}
                onChange={async (e) => {
                  const recallEnabled = e.target.checked;
                  setChangingMemory(true);
                  try {
                    setSession(
                      await api(`/spaces/${sid}/sessions/${session.id}`, 'PATCH', {
                        recallEnabled,
                      }),
                    );
                  } catch (error) {
                    notify(error.message, true);
                  } finally {
                    setChangingMemory(false);
                  }
                }}
              />{' '}
              允许从这段会话召回历史原话与已审阅摘要
            </label>
          </div>
        )}
        <div className="messages">
          {session?.hasMoreMessages && (
            <button
              className="secondary"
              disabled={loadingOlder || sending}
              onClick={async () => {
                setLoadingOlder(true);
                try {
                  const older = await api(
                    `/spaces/${sid}/sessions/${session.id}?before=${session.nextBefore}`,
                  );
                  preserveScroll.current = true;
                  setSession((s) => ({
                    ...s,
                    messages: [...older.messages, ...s.messages],
                    hasMoreMessages: older.hasMoreMessages,
                    nextBefore: older.nextBefore,
                  }));
                } catch (e) {
                  notify(e.message, true);
                } finally {
                  setLoadingOlder(false);
                }
              }}
            >
              {loadingOlder ? '正在读取…' : '加载较早消息'}
            </button>
          )}
          {loading ? (
            <div className="loading">
              <Loader2 className="spin" />
              读取对话…
            </div>
          ) : !session?.messages.length ? (
            <div className="chat-welcome">
              <span>✧</span>
              <h2>
                {snap.space.kind === 'companion'
                  ? '这会儿，想聊些什么？'
                  : '把想法带过来，我们一起理一理。'}
              </h2>
              <p>
                {configured
                  ? '会结合当前空间已确认的记忆，也认真听你此刻说的话。'
                  : '连接 DeepSeek 后，就可以从这里开始对话。'}
              </p>
              <div>
                {(snap.space.kind === 'companion'
                  ? ['今天想随便聊几句', '接着上次的话题吧']
                  : ['这个项目目前做了哪些决定？', '还有什么问题没有解决？']
                ).map((q) => (
                  <button key={q} onClick={() => setDraft(q)}>
                    {q}
                    <ArrowUpRight size={14} />
                  </button>
                ))}
              </div>
            </div>
          ) : (
            session.messages.map((m) => (
              <div className={`message ${m.role}`} key={m.id}>
                <span>{m.role === 'user' ? '你' : '✧'}</span>
                <div>
                  <div className="markdown">
                    <Markdown>{m.body}</Markdown>
                  </div>
                  <time>{time(m.created_at)}</time>
                  {m.role === 'assistant' && (
                    <button
                      className="text-button evidence-button"
                      onClick={() => setEvidenceId(m.id)}
                    >
                      <Quote size={12} /> 本轮参考
                    </button>
                  )}
                </div>
              </div>
            ))
          )}
          {sending && (
            <div className="thinking">
              <span>✧</span>
              <Loader2 size={14} className="spin" />
              正在想怎么接着说…
            </div>
          )}
          <div ref={bottom} />
        </div>
        {retry && (
          <div className="retry-bar">
            <span>这次没有收到回复，原消息仍可重试。</span>
            <button onClick={() => send(retry)} disabled={sending}>
              <RefreshCw size={13} />
              重试
            </button>
          </div>
        )}
        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            send({ body: draft, clientId: crypto.randomUUID() });
          }}
        >
          {!configured && (
            <div className="key-hint">
              <KeyRound size={14} />
              尚未连接模型
              <button type="button" onClick={onSettings}>
                去星工坊设置 <ArrowRight size={13} />
              </button>
            </div>
          )}
          <div>
            <textarea
              aria-label="聊天消息"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={
                snap.space.kind === 'companion' ? '说点什么吧…' : '把你的问题或想法写在这里…'
              }
              maxLength={12000}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  if (
                    configured &&
                    !sending &&
                    !loading &&
                    !loadingOlder &&
                    !deleting &&
                    !changingMemory &&
                    draft.trim()
                  )
                    send({ body: draft, clientId: crypto.randomUUID() });
                }
              }}
            />
            <button
              className="send-button"
              disabled={
                !configured ||
                sending ||
                !draft.trim() ||
                loading ||
                loadingOlder ||
                deleting ||
                changingMemory
              }
              aria-label="发送消息"
            >
              <Send size={18} />
            </button>
          </div>
          <small>
            Enter 发送 · Shift + Enter 换行 <span>AI 回复可能出错，重要结论请核对来源。</span>
          </small>
        </form>
      </section>
      {evidenceId && session && (
        <ReplyEvidenceView
          sid={sid}
          sessionId={session.id}
          messageId={evidenceId}
          canNavigate={!sending && !loading && !loadingOlder && !deleting && !changingMemory}
          onClose={() => setEvidenceId(null)}
          onConversation={(id) => {
            setEvidenceId(null);
            load(id);
          }}
        />
      )}
      {summaryOpen && session && (
        <Summaries
          key={session.id}
          sid={sid}
          sessionId={session.id}
          configured={configured}
          api={api}
          Modal={Modal}
          onClose={() => setSummaryOpen(false)}
        />
      )}
      {memoryView && (
        <Modal title="同空间的聊天记忆" onClose={() => setMemoryView(null)} wide>
          <p className="form-note">
            这些是自动保存的用户原话，可能含假设或已过时的表达，并非已确认知识。只保存在本机索引；需要回答时才将有限相关片段发送给
            DeepSeek。
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              showMemories(memoryQuery);
            }}
          >
            <label>
              查找过去聊过的内容
              <input
                value={memoryQuery}
                maxLength={2000}
                onChange={(e) => setMemoryQuery(e.target.value)}
                placeholder="留空查看近期原话"
              />
            </label>
            <button className="secondary">检索原话</button>
          </form>
          {!memoryView.enabled ? (
            <p>此空间已关闭聊天记忆召回，可以在星工坊重新开启。</p>
          ) : !memoryView.excerpts.length ? (
            <p>没有找到相关原话。</p>
          ) : (
            memoryView.excerpts.map((m) => (
              <blockquote key={m.id} className="memory-excerpt">
                <small>
                  {m.session_title} · {date(m.created_at)} {time(m.created_at)}
                </small>
                <p>
                  {m.truncated ? '…' : ''}
                  {m.quote}
                  {m.truncated ? '…' : ''}
                </p>
                <button
                  className="text-button"
                  disabled={sending || loadingOlder}
                  onClick={() => {
                    setMemoryView(null);
                    load(m.session_id);
                  }}
                >
                  打开原会话
                </button>
              </blockquote>
            ))
          )}
        </Modal>
      )}
      {deleteOpen && (
        <Modal
          title="删除这段会话？"
          onClose={() => {
            if (!deleting) setDeleteOpen(false);
          }}
        >
          <p>
            将删除「{session?.title}」的消息、聊天索引、会话摘要、摘要任务、MCP
            绑定及本会话的回答参考记录，并清理其他回答记录引用的这段原话与摘要，无法在界面恢复。其他会话已生成的回答、此前手动收为资料或确认的知识会保留，需另行处理。
          </p>
          <div className="button-row">
            <button className="secondary" disabled={deleting} onClick={() => setDeleteOpen(false)}>
              保留
            </button>
            <button
              className="primary"
              disabled={deleting}
              onClick={async () => {
                setDeleting(true);
                try {
                  await api(`/spaces/${sid}/sessions/${session.id}`, 'DELETE');
                  setSession(null);
                  setEvidenceId(null);
                  setRetry(null);
                  setDraft('');
                  setDeleteOpen(false);
                  localStorage.removeItem(`xingxi.session.${sid}`);
                  await reload();
                  notify('会话与聊天索引已删除。');
                } catch (e) {
                  notify(e.message, true);
                } finally {
                  setDeleting(false);
                }
              }}
            >
              {deleting ? '正在删除…' : '删除会话'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
createRoot(document.getElementById('root')).render(<App />);
