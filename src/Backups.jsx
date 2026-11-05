import React, { useEffect, useRef, useState } from 'react';
import { Archive, Copy, Loader2 } from 'lucide-react';

const shellQuote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
export default function Backups({ api, notify }) {
  const [data, setData] = useState(null),
    [starting, setStarting] = useState(false),
    [error, setError] = useState('');
  const alive = useRef(true),
    fetching = useRef(false),
    sequence = useRef(0);
  async function refresh() {
    if (fetching.current) return;
    fetching.current = true;
    const requestSequence = ++sequence.current;
    try {
      const next = await api('/backups');
      if (alive.current && requestSequence === sequence.current) {
        setData(next);
        setError('');
      }
    } catch (e) {
      if (alive.current) setError(e.message);
    } finally {
      fetching.current = false;
    }
  }
  useEffect(() => {
    alive.current = true;
    refresh();
    return () => {
      alive.current = false;
    };
  }, []);
  const running = starting || data?.active?.status === 'running';
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(refresh, 1500);
    return () => clearInterval(timer);
  }, [running]);
  async function start(operation, id) {
    setStarting(true);
    sequence.current++;
    try {
      const active = await api(
        operation === 'create' ? '/backups' : `/backups/${id}/${operation}`,
        'POST',
        {},
      );
      if (alive.current) setData((current) => ({ ...current, active }));
      await refresh();
    } catch (e) {
      notify(e.message, true);
    } finally {
      if (alive.current) setStarting(false);
    }
  }
  const job = data?.active;
  const restored = job?.status === 'done' && job.operation === 'restore' ? job.result : null;
  const command = restored
    ? data?.platform === 'win32'
      ? `$env:XINGXI_DATA_DIR='${restored.path.replaceAll("'", "''")}'; $env:XINGXI_NO_SEED='1'; $env:PORT='4182'; npm start`
      : `XINGXI_DATA_DIR=${shellQuote(restored.path)} XINGXI_NO_SEED=1 PORT=4182 npm start`
    : '';
  return (
    <section className="panel backup-panel">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">LOCAL BACKUP</span>
          <h2>给记忆留一份备份</h2>
        </div>
        <Archive size={20} />
      </div>
      <p className="panel-desc">
        包含全部空间的资料、知识、对话和参考记录。保存在本机，不复制模型配置与访问令牌文件。
      </p>
      <button className="secondary" disabled={running} onClick={() => start('create')}>
        {running && <Loader2 size={14} className="spin" />}创建本机备份
      </button>
      {error && (
        <p role="alert">
          {error}{' '}
          <button className="text-button" onClick={refresh}>
            重试读取
          </button>
        </p>
      )}
      {job && (
        <p className="form-note" role="status">
          {{ create: '创建备份', verify: '检查备份', restore: '恢复副本' }[job.operation]}：
          {job.status === 'running'
            ? '正在处理，可继续使用其他页面…'
            : job.status === 'done'
              ? '已完成并通过校验'
              : job.error}
        </p>
      )}
      {restored && (
        <div className="backup-restored">
          <strong>已恢复到独立目录</strong>
          <p>
            <code>{restored.path}</code>
          </p>
          <p className="form-note">
            在本项目终端运行以下命令打开副本。4182 可改为其他空闲端口；副本需重新配置 Key，MCP
            也需指定副本的数据目录和地址。
          </p>
          <pre>{command}</pre>
          <button
            className="text-button"
            onClick={() =>
              navigator.clipboard
                .writeText(command)
                .then(() => notify('启动命令已复制。'))
                .catch(() => notify('复制失败，请手动选择命令。', true))
            }
          >
            <Copy size={13} />
            复制启动命令
          </button>
        </div>
      )}
      <div className="backup-list">
        {data?.items.map((item) => (
          <article key={item.id}>
            <strong>{new Date(item.createdAt).toLocaleString('zh-CN')}</strong>
            <small>
              {(item.bytes / 1024 / 1024).toFixed(2)} MB · {item.counts.spaces} 个空间 ·{' '}
              {item.counts.messages} 条消息
            </small>
            <code>{item.path}</code>
            <div className="button-row">
              <button
                className="text-button"
                disabled={running}
                onClick={() => start('verify', item.id)}
              >
                检查完整性
              </button>
              <button
                className="text-button"
                disabled={running}
                onClick={() => start('restore', item.id)}
              >
                恢复为独立副本
              </button>
            </div>
          </article>
        ))}
      </div>
      {data && !data.items.length && <p className="form-note">尚无完成的备份。</p>}
      {data?.total > 20 && (
        <p className="form-note">显示最近 20 份，共 {data.total} 份。更早的备份仍在本机目录。</p>
      )}
      <p className="form-note">
        备份含私密内容，请保管整个备份目录。修改或删除原数据不会改写已有备份；恢复副本不会覆盖当前实例。
      </p>
    </section>
  );
}
