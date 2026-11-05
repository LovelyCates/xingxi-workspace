import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname, extname, sep } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { Store, Fault } from './store.mjs';
import { Service } from './service.mjs';
import { seed } from './seed.mjs';
import { Backups } from './backups.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = resolve(process.env.XINGXI_DATA_DIR || resolve(root, '.local'));
const port = Number(process.env.PORT || 4180);
const store = new Store(resolve(dataDir, 'xingxi.sqlite'));
if (process.env.XINGXI_NO_SEED !== '1') seed(store);
const service = new Service(store, dataDir);
const backups = new Backups(dataDir);
let vite;
if (process.argv.includes('--dev')) {
  const { createServer: createVite } = await import('vite');
  vite = await createVite({ root, server: { middlewareMode: true, hmr: false }, appType: 'spa' });
}
const same = (a, b) => {
  const x = Buffer.from(a || ''),
    y = Buffer.from(b || '');
  return x.length === y.length && timingSafeEqual(x, y);
};
const json = (res, value, status = 200) => {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(value));
};
async function body(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 1200000) throw new Fault('内容超过大小限制', 413);
    chunks.push(chunk);
  }
  try {
    const text = Buffer.concat(chunks).toString('utf8');
    const value = text ? JSON.parse(text) : {};
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error();
    return value;
  } catch {
    throw new Fault('请求 JSON 无效');
  }
}

const server = createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
  );
  const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (!hosts.includes(req.headers.host)) return json(res, { error: 'Host 不被允许' }, 403);
  try {
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host}`);
    } catch {
      throw new Fault('请求地址无效');
    }
    const path = url.pathname;
    if (path.startsWith('/api/')) {
      const bearer = req.headers.authorization?.replace(/^Bearer /, '');
      const cookie = req.headers.cookie
        ?.split(';')
        .map((x) => x.trim())
        .find((x) => x.startsWith('xingxi='))
        ?.slice(7);
      if (!same(bearer, service.token) && !same(cookie, service.token))
        throw new Fault('请刷新页面以重新连接本机服务', 401);
      if (req.headers.origin && !hosts.some((h) => req.headers.origin === `http://${h}`))
        throw new Fault('不允许跨站请求', 403);
      if (req.headers['sec-fetch-site'] === 'cross-site') throw new Fault('不允许跨站请求', 403);
      const method = req.method,
        b = ['POST', 'PUT', 'PATCH'].includes(method) ? await body(req) : {};
      if (path === '/api/settings') {
        if (method === 'GET') return json(res, service.settings());
        if (method === 'PUT') return json(res, service.saveSettings(b));
      }
      if (path === '/api/backups' && method === 'GET') return json(res, await backups.list());
      if (path === '/api/backups' && method === 'POST')
        return json(res, await backups.start('create'), 202);
      const backupRoute = path.match(/^\/api\/backups\/([^/]+)\/(verify|restore)$/);
      if (backupRoute && method === 'POST')
        return json(res, await backups.start(backupRoute[2], backupRoute[1]), 202);
      if (path === '/api/spaces') {
        if (method === 'GET') return json(res, store.spaces());
        if (method === 'POST') return json(res, store.createSpace(b), 201);
      }
      const m = path.match(/^\/api\/spaces\/([^/]+)(?:\/(.*))?$/);
      if (!m) throw new Fault('接口不存在', 404);
      const sid = m[1],
        tail = m[2] || '';
      store.space(sid);
      if (tail === 'view' && method === 'GET')
        return json(res, store.views.read(sid, Object.fromEntries(url.searchParams)));
      if (tail === 'entries' && method === 'GET')
        return json(res, store.views.entries(sid, Object.fromEntries(url.searchParams)));
      if (tail === 'sources' && method === 'GET')
        return json(res, store.views.sources(sid, Object.fromEntries(url.searchParams)));
      if (!tail && method === 'GET') return json(res, store.snapshot(sid));
      if (!tail && method === 'PATCH') return json(res, store.updateSpace(sid, b));
      if (tail === 'context' && method === 'GET')
        return json(res, store.context(sid, url.searchParams.get('q') || ''));
      if (tail === 'conversation-context' && method === 'GET')
        return json(res, store.conversationContext(sid, url.searchParams.get('q') || ''));
      if (tail === 'sources' && method === 'POST') return json(res, store.ingest(sid, b), 201);
      if (tail === 'entries' && method === 'POST') return json(res, store.propose(sid, b), 201);
      if (tail === 'relations' && method === 'POST') return json(res, store.relate(sid, b), 201);
      if (tail === 'compile' && method === 'POST')
        return json(res, service.compile(sid, b.sourceId), 202);
      if (tail === 'sessions' && method === 'POST')
        return json(res, store.createSession(sid, b.title), 201);
      if (tail === 'sessions' && method === 'GET')
        return json(
          res,
          store.sessionList(sid, { before: url.searchParams.get('before') ?? undefined }),
        );
      if (tail === 'session-open' && method === 'POST') return json(res, store.openSession(sid, b));
      if (tail === 'export' && method === 'GET') {
        res.writeHead(200, {
          'Content-Type': 'text/markdown; charset=utf-8',
          'Content-Disposition': 'attachment; filename="xingxi.md"',
        });
        return res.end(store.exportMarkdown(sid));
      }
      const parts = tail.split('/'),
        id = parts[1];
      if (parts[0] === 'sources' && id && method === 'GET') return json(res, store.source(sid, id));
      if (parts[0] === 'entries' && id) {
        if (parts[2] === 'detail' && method === 'GET')
          return json(res, store.views.detail(sid, id));
        if (parts[2] === 'neighbors' && method === 'GET')
          return json(
            res,
            store.views.neighbors(sid, id, { after: url.searchParams.get('after') }),
          );
        if (parts[2] === 'history' && method === 'GET') return json(res, store.history(sid, id));
        if (method === 'GET') return json(res, store.entry(sid, id));
        if (method === 'PATCH') return json(res, store.updateEntry(sid, id, b));
      }
      if (parts[0] === 'jobs' && id && method === 'GET') return json(res, service.job(sid, id));
      if (parts[0] === 'sessions' && id) {
        if (parts.length === 2 && method === 'PATCH')
          return json(res, store.updateSession(sid, id, b));
        if (parts.length === 2 && method === 'DELETE')
          return json(res, service.deleteSession(sid, id));
        if (
          parts.length === 5 &&
          parts[2] === 'messages' &&
          parts[4] === 'evidence' &&
          method === 'GET'
        )
          return json(res, store.replyEvidence.read(sid, id, parts[3]));
        if (parts[2] === 'source' && method === 'POST')
          return json(res, store.sessionSource(sid, id), 201);
        if (parts[2] === 'reply' && method === 'POST')
          return json(res, await service.reply(sid, id, b));
        if (parts[2] === 'messages' && method === 'POST')
          return json(res, store.append(sid, id, b));
        if (method === 'GET')
          return json(
            res,
            store.session(sid, id, {
              before: url.searchParams.get('before') ?? undefined,
              limit: url.searchParams.get('limit') ?? 100,
            }),
          );
      }
      throw new Fault('接口不存在', 404);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new Fault('请求方法不支持', 405);
    if (path === '/' || path === '/index.html')
      res.setHeader('Set-Cookie', `xingxi=${service.token}; HttpOnly; SameSite=Strict; Path=/`);
    if (vite) return vite.middlewares(req, res);
    const dist = resolve(root, 'dist');
    const file = resolve(dist, `.${decodeURIComponent(path === '/' ? '/index.html' : path)}`);
    if (!file.startsWith(dist + sep)) throw new Fault('路径无效', 403);
    if (!existsSync(file) || !statSync(file).isFile())
      throw new Fault('页面不存在，请先执行 npm run build。', 404);
    const types = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.woff2': 'font/woff2',
    };
    res.writeHead(200, {
      'Content-Type': types[extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'Content-Security-Policy':
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    });
    res.end(readFileSync(file));
  } catch (e) {
    json(
      res,
      { error: e instanceof Fault ? e.message : '服务出错，请检查本机运行状态。' },
      e.status || 500,
    );
    if (!(e instanceof Fault)) console.error('星汐请求失败；未记录请求正文或错误原文。');
  }
});
server.listen(port, '127.0.0.1', () =>
  console.log(`星汐已启动：http://127.0.0.1:${port} · 数据保存在 ${dataDir}`),
);
const shutdown = () =>
  server.close(async () => {
    await service.queue;
    await backups.pending;
    store.close();
    if (vite) await vite.close();
    process.exit(0);
  });
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
