/**
 * Adapted from Yuuyuko-uu/dsh-xingxi client.js (星点纹理、透视投影).
 * Copyright (c) 2026 Yuuyuko-uu. Yuuyuko-uu 插件许可 1.1.
 * Changes: ES module API, English identifiers, deterministic placement and
 * reduced, static background for Xingxi's accessible DOM graph overlay.
 * Upstream: https://github.com/Yuuyuko-uu/dsh-xingxi
 */
export function projectPoint(x, y, z, rotation, tilt, scale, width, height) {
  const x1 = x * Math.cos(rotation) + z * Math.sin(rotation);
  const z1 = -x * Math.sin(rotation) + z * Math.cos(rotation);
  const y2 = y * Math.cos(tilt) - z1 * Math.sin(tilt);
  const z2 = y * Math.sin(tilt) + z1 * Math.cos(tilt);
  const k = (2400 / (2400 + z2)) * scale;
  return { x: width / 2 + x1 * k, y: height / 2 + y2 * k, k };
}
export function makeStarSprite(rgb) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext('2d');
  const glow = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  [
    [0, 1],
    [0.055, 0.98],
    [0.16, 0.78],
    [0.38, 0.32],
    [0.68, 0.085],
    [1, 0],
  ].forEach(([p, a]) => glow.addColorStop(p, `rgba(${rgb},${a})`));
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, 64, 64);
  const core = ctx.createRadialGradient(32, 32, 0, 32, 32, 7);
  core.addColorStop(0, 'rgba(255,255,255,.84)');
  core.addColorStop(0.4, 'rgba(255,255,255,.34)');
  core.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.globalCompositeOperation = 'screen';
  ctx.fillStyle = core;
  ctx.fillRect(0, 0, 64, 64);
  return canvas;
}
export function paintSky(canvas) {
  const w = canvas.clientWidth,
    h = canvas.clientHeight,
    dpr = Math.min(devicePixelRatio || 1, 2);
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const sprite = makeStarSprite('173,187,248');
  let seed = 571;
  const rand = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  for (let i = 0; i < 170; i++) {
    const x = rand() * w,
      y = rand() * h,
      size = rand() > 0.94 ? 10 : 2 + rand() * 3;
    ctx.globalAlpha = 0.2 + rand() * 0.45;
    ctx.drawImage(sprite, x, y, size, size);
  }
}
