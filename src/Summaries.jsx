import React, { useEffect, useRef, useState } from 'react';

const statusNames = { pending: '待审阅', accepted: '已允许召回', archived: '已归档' };
const stamp = (value) => new Date(value).toLocaleString('zh-CN');

export default function Summaries({ sid, sessionId, configured, api, Modal, onClose }) {
  const path = `/spaces/${sid}/sessions/${sessionId}/summaries`;
  const [data, setData] = useState(null);
  const [before, setBefore] = useState(null);
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const live = useRef(true),
    request = useRef(0);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      request.current++;
    };
  }, []);
  async function refresh(cursor = before) {
    const seq = ++request.current;
    try {
      const result = await api(`${path}${cursor ? `?before=${cursor}` : ''}`);
      if (live.current && seq === request.current) setData(result);
    } catch (e) {
      if (live.current && seq === request.current) setError(e.message);
    }
  }
  useEffect(() => {
    setData(null);
    refresh(before);
  }, [before]);
  const active = data?.jobs.find((j) => ['queued', 'running'].includes(j.status));
  useEffect(() => {
    if (!active) return;
    // Schedule only after a response; no overlapping interval requests.
    const timer = setTimeout(() => refresh(before), 1500);
    return () => clearTimeout(timer);
  }, [data, before]);
  async function open(id) {
    setReading(true);
    setError('');
    try {
      const result = await api(`${path}/${id}`);
      if (live.current) setDetail(result);
    } catch (e) {
      if (live.current) setError(e.message);
    } finally {
      if (live.current) setReading(false);
    }
  }
  async function build() {
    setBusy(true);
    setError('');
    try {
      await api(path, 'POST', {});
      if (live.current) {
        setBefore(null);
        await refresh(null);
      }
    } catch (e) {
      if (live.current) setError(e.message);
    } finally {
      if (live.current) setBusy(false);
    }
  }
  async function review(status) {
    setBusy(true);
    setError('');
    try {
      const result = await api(`${path}/${detail.id}`, 'PATCH', {
        revision: detail.revision,
        items: detail.items,
        status,
      });
      if (live.current) {
        setDetail(result);
        await refresh();
      }
    } catch (e) {
      if (live.current) setError(e.message);
    } finally {
      if (live.current) setBusy(false);
    }
  }
  function edit(index, field, value) {
    setDetail((current) => ({
      ...current,
      items: current.items.map((item, i) => (i === index ? { ...item, [field]: value } : item)),
    }));
  }
  return (
    <Modal title="会话摘要" onClose={onClose} wide>
      <div className="summary-panel">
        <p className="form-note">
          把早期讨论留成带出处的摘要。你的表达与星汐的建议分开保存；只有审阅并允许后，摘要才会用于同空间后续对话。
        </p>
        {error && <p role="alert">{error}</p>}
        {detail ? (
          <>
            <div className="summary-actions">
              <button
                className="text-button"
                disabled={busy}
                onClick={() => {
                  setDetail(null);
                  setError('');
                }}
              >
                返回摘要目录
              </button>
              <span>
                {statusNames[detail.status]} · 版本 {detail.revision}
              </span>
            </div>
            <p className="form-note">
              整理于 {stamp(detail.created_at)} · 覆盖 {detail.covered_count}{' '}
              条消息。下方时间是原消息时间；请对照原话检查否定、假设与时间变化。
            </p>
            {detail.items.length === 0 && <p>这一段没有提取出值得保留的摘要，原消息仍完整保存。</p>}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                review('accepted');
              }}
            >
              {detail.items.map((item, i) => (
                <article className="summary-item" key={i}>
                  <strong>{item.role === 'user' ? '你的表达' : '星汐的建议或回答'}</strong>
                  <label>
                    主题
                    <input
                      aria-label={`摘要 ${i + 1} 主题`}
                      value={item.title}
                      maxLength={120}
                      required
                      disabled={busy}
                      onChange={(e) => edit(i, 'title', e.target.value)}
                    />
                  </label>
                  <label>
                    摘要
                    <textarea
                      aria-label={`摘要 ${i + 1} 内容`}
                      value={item.body}
                      maxLength={1000}
                      required
                      disabled={busy}
                      onChange={(e) => edit(i, 'body', e.target.value)}
                    />
                  </label>
                  {item.evidence.map((ev, n) => (
                    <blockquote className="memory-excerpt" key={n}>
                      <small>
                        {ev.role === 'user' ? '你的原话' : '星汐原回复'} · {stamp(ev.created_at)}
                      </small>
                      <p>{ev.quote}</p>
                      <details>
                        <summary>消息标识</summary>
                        <code>{ev.messageId}</code>
                      </details>
                    </blockquote>
                  ))}
                </article>
              ))}
              <p className="form-note">
                允许召回仅确认这份摘要可供参考，不会把助手建议登记为你的决定。原话出处不可在这里改写。
              </p>
              <div className="summary-actions">
                <button className="primary" disabled={busy || !detail.items.length}>
                  保存并允许召回
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() => review('pending')}
                >
                  保存为待审阅
                </button>
                <button
                  type="button"
                  className="text-button"
                  disabled={busy}
                  onClick={() => review('archived')}
                >
                  归档并停止召回
                </button>
              </div>
            </form>
          </>
        ) : (
          <>
            <div className="summary-overview">
              <div>
                <strong>{data ? `${data.coverage.covered} / ${data.coverage.total}` : '…'}</strong>
                <small>已整理消息 / 全部消息</small>
              </div>
              <button
                className="primary"
                disabled={
                  !data ||
                  busy ||
                  Boolean(active) ||
                  !configured ||
                  data.coverage.covered >= data.coverage.total
                }
                onClick={build}
              >
                {active ? '正在整理…' : '整理下一段'}
              </button>
            </div>
            <p className="form-note">
              每次最多处理 40 条、24,000 字符，会调用已配置的 DeepSeek
              并产生模型费用。按时间从未整理处继续；不会后台自动发起。
              {!configured && '请先在星工坊连接模型。'}
            </p>
            {active && (
              <p role="status">
                {active.status === 'queued'
                  ? '等待前一个整理任务完成…'
                  : '正在提取摘要，完成后请打开审阅。'}
              </p>
            )}
            {data?.jobs[0]?.status === 'failed' && (
              <p role="alert">上次整理未完成：{data.jobs[0].error}。原消息仍保留，可重新整理。</p>
            )}
            {!data ? (
              <p>读取摘要目录…</p>
            ) : data.summaries.length === 0 ? (
              <p>还没有摘要。原话记忆仍照常保存与召回。</p>
            ) : (
              data.summaries.map((summary) => (
                <button
                  className="summary-row"
                  key={summary.id}
                  disabled={reading || busy}
                  onClick={() => open(summary.id)}
                >
                  <span>
                    <strong>{statusNames[summary.status]}</strong>
                    <small>
                      {stamp(summary.created_at)} · 覆盖 {summary.covered_count} 条消息
                    </small>
                  </span>
                  <span>{summary.item_count} 项 · 查看审阅 →</span>
                </button>
              ))
            )}
            <div className="summary-actions">
              {before && (
                <button
                  className="text-button"
                  disabled={reading || busy}
                  onClick={() => setBefore(null)}
                >
                  最新摘要
                </button>
              )}
              {data?.hasMore && (
                <button
                  className="secondary"
                  disabled={reading || busy}
                  onClick={() => setBefore(data.nextBefore)}
                >
                  更早摘要
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
