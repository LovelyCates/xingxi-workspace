import React, { useState, useEffect, useRef } from 'react';

const states = {
  pending: '待审阅',
  active: '当前生效',
  scheduled: '等待生效',
  superseded: '已有更新的变更',
  disabled: '来源已关闭召回',
  stale: '目标已更新，需重新核对',
  unavailable: '依据已删除',
  archived: '已归档',
};
const kinds = { correction: '纠正旧说法', change: '情况发生变化', conflict: '仍有冲突，待核实' };
const targetKinds = { knowledge: '知识条目', conversation: '历史消息', summary: '会话摘要' };
const stamp = (value) => new Date(value).toLocaleString('zh-CN');

export default function MemoryChanges({ sid, api, Modal, onClose, onChange }) {
  const [data, setData] = useState(null),
    [detail, setDetail] = useState(null),
    [creating, setCreating] = useState(false);
  const [before, setBefore] = useState(null),
    [filter, setFilter] = useState('all'),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [query, setQuery] = useState(''),
    [candidates, setCandidates] = useState([]),
    [target, setTarget] = useState(null);
  const [title, setTitle] = useState(''),
    [body, setBody] = useState(''),
    [kind, setKind] = useState('correction'),
    [effective, setEffective] = useState(''),
    [archiveCheck, setArchiveCheck] = useState(false);
  const live = useRef(true),
    seq = useRef(0);
  const path = `/spaces/${sid}/changes`;
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      seq.current++;
    };
  }, []);
  async function load(cursor = before) {
    const n = ++seq.current;
    try {
      const out = await api(`${path}?status=${filter}${cursor ? `&before=${cursor}` : ''}`);
      if (live.current && n === seq.current) setData(out);
    } catch (e) {
      if (live.current && n === seq.current) setError(e.message);
    }
  }
  useEffect(() => {
    setData(null);
    load();
  }, [before, filter]);
  async function act(fn) {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      if (live.current) setError(e.message);
    } finally {
      if (live.current) setBusy(false);
    }
  }
  async function search() {
    await act(async () => {
      const result = await api(`${path}/candidates?q=${encodeURIComponent(query)}`);
      if (live.current) setCandidates(result.items);
    });
  }
  async function select(candidate) {
    await act(async () => {
      const result = await api(
        `${path}/target?kind=${candidate.kind}&id=${candidate.id}&position=${candidate.position}`,
      );
      if (live.current) {
        setTarget(result);
        setTitle(result.title.slice(0, 120));
      }
    });
  }
  async function open(id) {
    await act(async () => {
      const result = await api(`${path}/${id}`);
      if (live.current) {
        setDetail(result);
        setArchiveCheck(false);
      }
    });
  }
  async function save() {
    await act(async () => {
      const result = await api(`${path}/manual`, 'POST', {
        kind,
        title,
        body,
        target: {
          kind: target.kind,
          id: target.id,
          position: target.position,
          revision: target.revision,
        },
        ...(effective ? { effectiveAt: new Date(effective).toISOString() } : {}),
      });
      if (live.current) {
        setCreating(false);
        setDetail(result);
        setBefore(null);
        await load(null);
        await onChange();
      }
    });
  }
  async function review(status) {
    await act(async () => {
      const result = await api(`${path}/${detail.id}`, 'PATCH', {
        revision: detail.revision,
        status,
      });
      if (live.current) {
        setDetail(result);
        setArchiveCheck(false);
        await load();
        await onChange();
      }
    });
  }
  function start() {
    setCreating(true);
    setDetail(null);
    setTarget(null);
    setCandidates([]);
    setQuery('');
    setTitle('');
    setBody('');
    setEffective('');
    setKind('correction');
    setError('');
  }
  function back() {
    setDetail(null);
    setCreating(false);
    setArchiveCheck(false);
    setError('');
  }
  return (
    <Modal title="记忆变更" onClose={onClose} wide>
      <div className="summary-panel">
        <p className="form-note">
          把旧说法与新的依据放在一起核对。确认后，按生效时间使用最新变更；仍有冲突时，暂不采用对应旧结论。原文会保留。
        </p>
        {error && <p role="alert">{error}</p>}
        {(detail || creating) && (
          <button className="text-button" disabled={busy} onClick={back}>
            返回变更目录
          </button>
        )}
        {creating ? (
          <>
            {!target ? (
              <>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    search();
                  }}
                >
                  <label>
                    先找到需要纠正的旧内容
                    <input
                      aria-label="查找变更目标"
                      value={query}
                      maxLength={2000}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="关键词；留空查看近期内容"
                    />
                  </label>
                  <button className="secondary" disabled={busy}>
                    查找旧记忆
                  </button>
                </form>
                <p className="form-note">
                  每次显示最多 10 条知识、10 条原话和 4
                  项摘要。可缩小关键词；聊天与摘要目标需开启召回后才能在这里查找。
                </p>
                <div className="change-target-list">
                  {candidates.map((c) => (
                    <button
                      className="summary-row"
                      key={`${c.kind}:${c.id}:${c.position}`}
                      disabled={busy}
                      onClick={() => select(c)}
                    >
                      <span>
                        <small>
                          {targetKinds[c.kind]} ·{' '}
                          {c.role === 'assistant'
                            ? '助手建议或回答'
                            : c.role === 'user'
                              ? '用户原话或摘要'
                              : '已确认知识'}
                        </small>
                        <strong>{c.title}</strong>
                        <small>{c.body}</small>
                      </span>
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <>
                <article className="change-comparison">
                  <small>
                    原记录 · {targetKinds[target.kind]} ·{' '}
                    {target.role === 'assistant'
                      ? '助手内容'
                      : target.role === 'user'
                        ? '用户内容'
                        : '已确认知识'}
                  </small>
                  <h3>{target.title}</h3>
                  <p>{target.body}</p>
                </article>
                <button className="text-button" disabled={busy} onClick={() => setTarget(null)}>
                  重新选择原记录
                </button>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    save();
                  }}
                >
                  <label>
                    变更主题
                    <input
                      value={title}
                      required
                      maxLength={120}
                      onChange={(e) => setTitle(e.target.value)}
                    />
                  </label>
                  <label>
                    如何处理
                    <select value={kind} onChange={(e) => setKind(e.target.value)}>
                      {Object.entries(kinds).map(([k, v]) => (
                        <option key={k} value={k}>
                          {v}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    现在应如何理解
                    <textarea
                      aria-label="变更说明"
                      value={body}
                      required
                      maxLength={1000}
                      onChange={(e) => setBody(e.target.value)}
                      placeholder="写清新的情况、纠正的原因，或哪些结论仍需确认。"
                    />
                  </label>
                  <label>
                    生效时间（本机时区；留空为现在）
                    <input
                      type="datetime-local"
                      value={effective}
                      onChange={(e) => setEffective(e.target.value)}
                    />
                  </label>
                  <p className="form-note">
                    这段文字会作为独立原始资料保存在本空间，再生成待审阅变更。不调用模型。归档变更不会删除这份资料。
                  </p>
                  <button className="primary" disabled={busy || !body.trim()}>
                    保存待审阅变更
                  </button>
                </form>
              </>
            )}
          </>
        ) : detail ? (
          <>
            <div className="summary-actions">
              <strong>{states[detail.state]}</strong>
              <span>
                {kinds[detail.kind]} · 版本 {detail.revision}
              </span>
            </div>
            <h3>{detail.title || '变更依据已删除'}</h3>
            <p className="form-note">生效时间：{stamp(detail.effective_at)}</p>
            {detail.target.body && (
              <article className="change-comparison">
                <small>
                  对应旧内容 · {targetKinds[detail.target_kind]} ·{' '}
                  {detail.target.role === 'assistant' ? '助手内容' : '原记录'}
                </small>
                <h4>{detail.target.title}</h4>
                <p>{detail.target.body}</p>
                {detail.target.truncated && <small>此处为旧内容片段。</small>}
              </article>
            )}
            {detail.body && (
              <article className="change-comparison current">
                <small>{detail.kind === 'conflict' ? '仍需核实的冲突' : '审阅后的理解'}</small>
                <p>{detail.body}</p>
                <details>
                  <summary>查看原文依据</summary>
                  <blockquote>{detail.quote}</blockquote>
                  <small>
                    {detail.source_kind === 'conversation' ? '来自用户消息' : '来自原始资料'} ·{' '}
                    {detail.source_id}
                  </small>
                </details>
              </article>
            )}
            {detail.state === 'unavailable' && (
              <p className="form-note">
                依据正文与引用已清理。如果这条变更曾经确认并已生效，对应旧记录仍暂不用于召回，避免退回过期结论。可以重新提交有出处的变更，或明确归档以解除限制。
              </p>
            )}
            {detail.state === 'stale' && (
              <p className="form-note">
                原记录版本或状态已变化，这条变更不再适用。请核对最新内容后重新提交。
              </p>
            )}
            {detail.state === 'disabled' && (
              <p className="form-note">
                来源或目标会话已关闭召回，因此不向模型提供这条变更，也不会自动恢复对应旧结论。
              </p>
            )}
            <div className="summary-actions">
              <button
                className="primary"
                disabled={
                  busy || !detail.source_ok || !detail.target_ok || detail.status === 'accepted'
                }
                onClick={() => review('accepted')}
              >
                确认并按时间生效
              </button>
              <button
                className="text-button"
                disabled={busy || detail.status === 'archived'}
                onClick={() => setArchiveCheck(true)}
              >
                归档这条变更
              </button>
            </div>
            {archiveCheck && (
              <div className="change-warning">
                <p>
                  归档后，若没有其他生效变更，旧记录或此前的变更可能重新用于回答。确认解除这条限制？
                </p>
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() => setArchiveCheck(false)}
                >
                  保留变更
                </button>{' '}
                <button className="primary" disabled={busy} onClick={() => review('archived')}>
                  确认归档
                </button>
              </div>
            )}
            <details>
              <summary>最近 20 条审阅记录</summary>
              <ol>
                {detail.events.map((e) => (
                  <li key={e.revision}>
                    版本 {e.revision} ·{' '}
                    {e.status === 'accepted'
                      ? '确认'
                      : e.status === 'pending'
                        ? '创建候选'
                        : e.status === 'archived'
                          ? '归档'
                          : '依据已删除'}{' '}
                    · {stamp(e.created_at)}
                  </li>
                ))}
              </ol>
            </details>
          </>
        ) : (
          <>
            <div className="summary-actions">
              <select
                aria-label="变更状态筛选"
                value={filter}
                onChange={(e) => {
                  setFilter(e.target.value);
                  setBefore(null);
                }}
              >
                {[
                  ['all', '全部变更'],
                  ['pending', '待审阅'],
                  ['accepted', '已确认'],
                  ['archived', '已归档'],
                  ['unavailable', '依据已删除'],
                ].map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
              <button className="primary" onClick={start}>
                记录一次变更
              </button>
            </div>
            {!data ? (
              <p>读取变更目录…</p>
            ) : !data.items.length ? (
              <p>还没有这类变更。新的纠正、时间变化和待核实冲突都可以在这里记录。</p>
            ) : (
              data.items.map((c) => (
                <button
                  className="summary-row"
                  key={c.id}
                  disabled={busy}
                  onClick={() => open(c.id)}
                >
                  <span>
                    <strong>{c.title || '变更依据已删除'}</strong>
                    <small>
                      {kinds[c.kind]} · {stamp(c.effective_at)}
                    </small>
                  </span>
                  <span>{states[c.state]} →</span>
                </button>
              ))
            )}
            <div className="summary-actions">
              {before && (
                <button className="text-button" onClick={() => setBefore(null)}>
                  最新变更
                </button>
              )}
              {data?.hasMore && (
                <button className="secondary" onClick={() => setBefore(data.nextBefore)}>
                  更早变更
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
