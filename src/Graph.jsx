import React, { useEffect, useRef, useState, useMemo } from 'react';
import { Minus, Plus, RotateCcw, Orbit, ArrowUpRight } from 'lucide-react';
import { projectPoint, paintSky } from './star-renderer';
import { graphSubset } from './graph-layout';

export const kindNames = {
  concept: '概念',
  decision: '决策',
  question: '问题',
  preference: '偏好',
  experience: '经历',
  agreement: '约定',
};
export const kindColors = {
  concept: '#a6b4fc',
  decision: '#8dd9ca',
  question: '#e5bd88',
  preference: '#d1aff0',
  experience: '#f0b4bf',
  agreement: '#a8cbdc',
};
export default function Graph({ entries, relations, onSelect, selected, paged = false }) {
  const host = useRef(),
    sky = useRef();
  const [size, setSize] = useState({ w: 900, h: 600 }),
    [zoom, setZoom] = useState(1),
    [rotation, setRotation] = useState(0);
  useEffect(() => {
    const obs = new ResizeObserver(() => {
      if (!host.current || !sky.current) return;
      const r = host.current.getBoundingClientRect();
      setSize({ w: r.width, h: r.height });
      paintSky(sky.current);
    });
    obs.observe(host.current);
    return () => obs.disconnect();
  }, []);
  const { nodes: ordered, edges } = useMemo(
    () => graphSubset(entries, relations),
    [entries, relations],
  );
  const n = ordered.length,
    rx = Math.min(size.w * 0.34, 320),
    ry = Math.min(size.h * 0.33, 215);
  const points = ordered.map((e, i) => {
    const angle = (i / Math.max(n - 1, 1)) * Math.PI * 2 - 0.65;
    const ring = i % 3 === 0 ? 0.63 : 1;
    const p =
      i === 0
        ? { x: size.w * 0.48, y: size.h * 0.47 }
        : projectPoint(
            Math.cos(angle) * rx * ring,
            Math.sin(angle) * ry * ring,
            ((i % 3) - 1) * 60,
            rotation,
            0.16,
            zoom,
            size.w,
            size.h,
          );
    return { ...e, ...p };
  });
  const map = new Map(points.map((e) => [e.id, e]));
  return (
    <div className="galaxy" ref={host}>
      <canvas className="sky" ref={sky} aria-hidden="true" />
      <div className="galaxy-nebula" aria-hidden="true" />
      <div className="orbit-ring ring-one" aria-hidden="true" />
      <div className="orbit-ring ring-two" aria-hidden="true" />
      <div className="graph-caption">
        <span className="eyebrow">CONSTELLATION / 01</span>
        <span>每一次理解，都让星星靠近一点。</span>
      </div>
      <svg className="graph-lines" width={size.w} height={size.h} aria-hidden="true">
        <defs>
          <linearGradient id="edge">
            <stop stopColor="#acb8ef" stopOpacity=".48" />
            <stop offset="1" stopColor="#8095c2" stopOpacity=".13" />
          </linearGradient>
        </defs>
        {edges.map((r) => {
          const a = map.get(r.from_id),
            b = map.get(r.to_id);
          if (!a || !b) return null;
          const active = selected === a.id || selected === b.id;
          return (
            <g key={r.id}>
              <path
                d={`M ${a.x} ${a.y} Q ${(a.x + b.x) / 2 + 18} ${(a.y + b.y) / 2 - 20} ${b.x} ${b.y}`}
                fill="none"
                stroke={active ? '#b7bfea' : 'url(#edge)'}
                strokeWidth={active ? 1.2 : 0.8}
                strokeDasharray={r.label === '待研究' ? '3 5' : undefined}
              />
              {active && (
                <text
                  x={(a.x + b.x) / 2 + 8}
                  y={(a.y + b.y) / 2 - 15}
                  fill="#a2accb"
                  textAnchor="middle"
                  fontSize="10"
                >
                  {r.label}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {points.map((e, i) => (
        <button
          key={e.id}
          className={`star-node ${selected === e.id ? 'selected' : ''} ${i === 0 ? 'anchor' : ''}`}
          style={{ left: e.x, top: e.y, '--star': kindColors[e.kind] }}
          onClick={() => onSelect(e)}
          aria-label={`查看${kindNames[e.kind]}：${e.title}`}
        >
          <span className="star-light" />
          <span className="star-label">{e.title}</span>
        </button>
      ))}
      {!n && (
        <div className="empty graph-empty">
          <Orbit size={38} />
          <h3>你的第一颗星，正等着被点亮</h3>
          <p>导入一段资料，确认一条记忆，星图就会开始生长。</p>
        </div>
      )}
      <div className="graph-bottom">
        <span>
          <span className="live-dot" /> {n} 颗星
          {paged
            ? ' · 当前分页，可翻页或按关键词筛选'
            : entries.length > n
              ? ` / 共 ${entries.length} 颗，请筛选查看`
              : ' · 点击探索出处'}{' '}
          <ArrowUpRight size={13} />
        </span>
        <div className="graph-controls">
          <button aria-label="缩小星图" onClick={() => setZoom((z) => Math.max(0.55, z - 0.15))}>
            <Minus size={16} />
          </button>
          <button aria-label="放大星图" onClick={() => setZoom((z) => Math.min(1.3, z + 0.15))}>
            <Plus size={16} />
          </button>
          <button aria-label="旋转星图" onClick={() => setRotation((r) => r + 0.35)}>
            <Orbit size={16} />
          </button>
          <button
            aria-label="重置星图"
            onClick={() => {
              setZoom(1);
              setRotation(0);
            }}
          >
            <RotateCcw size={15} />
          </button>
        </div>
      </div>
    </div>
  );
}
