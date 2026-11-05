import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { get } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

test('真实 HTTP 与 stdio MCP：认证、跨站拒绝、命名空间、入库及会话连续性', async (t) => {
  const probe = createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  const dir = mkdtempSync(join(tmpdir(), 'xingxi-http-')),
    base = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env,
    XINGXI_DATA_DIR: dir,
    XINGXI_NO_SEED: '1',
    PORT: String(port),
  };
  const proc = spawn(process.execPath, ['server/http.mjs'], {
    cwd: resolve('.'),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  proc.stderr.on('data', (x) => {
    logs += x;
  });
  t.after(async () => {
    const exited = once(proc, 'exit');
    proc.kill('SIGTERM');
    await exited;
    rmSync(dir, { recursive: true, force: true });
  });
  await Promise.race([
    once(proc.stdout, 'data'),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`服务未启动 ${logs}`)), 8000).unref(),
    ),
  ]);
  const token = readFileSync(join(dir, 'access-token'), 'utf8');
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  assert.equal((await fetch(`${base}/api/spaces`)).status, 401);
  assert.equal(
    (await fetch(`${base}/api/spaces`, { headers: { ...headers, Origin: 'https://evil.example' } }))
      .status,
    403,
  );
  const badHost = await new Promise((resolve, reject) => {
    get(`${base}/api/spaces`, { headers: { ...headers, Host: 'evil.example' } }, (r) => {
      r.resume();
      resolve(r.statusCode);
    }).on('error', reject);
  });
  assert.equal(badHost, 403);
  const make = async (name) =>
    await (
      await fetch(`${base}/api/spaces`, { method: 'POST', headers, body: JSON.stringify({ name }) })
    ).json();
  const a = await make('A'),
    b = await make('B');
  const client = new Client({ name: 'xingxi-integration-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve('server/mcp.mjs')],
    env: { ...env, XINGXI_URL: base },
    stderr: 'pipe',
  });
  await client.connect(transport);
  t.after(() => client.close());
  const list = await client.listTools();
  assert.ok(list.tools.some((x) => x.name === 'chat_reply'));
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    return r.isError ? r : JSON.parse(r.content[0].text);
  };
  assert.equal((await call('space_list')).length, 2);
  const source = await call('wiki_ingest', {
    spaceId: a.id,
    title: '集成资料',
    body: '本机优先运行。',
  });
  const bad = await call('memory_propose', {
    spaceId: b.id,
    title: '错误引用',
    body: '本机运行',
    kind: 'decision',
    evidence: [{ sourceId: source.id, quote: '本机优先运行。' }],
  });
  assert.equal(bad.isError, true);
  const good = await call('memory_propose', {
    spaceId: a.id,
    title: '本机运行',
    body: '本机优先运行。',
    kind: 'decision',
    evidence: [{ sourceId: source.id, quote: '本机优先运行。' }],
  });
  assert.equal(good.status, 'pending');
  assert.equal((await call('context_get', { spaceId: a.id, query: '本机' })).entries.length, 0);
  const s = await call('session_create', { spaceId: a.id, title: 'Agent 对话' });
  await call('session_append', {
    spaceId: a.id,
    sessionId: s.id,
    role: 'user',
    body: '下次继续',
    clientId: 'test-1',
  });
  await call('session_append', {
    spaceId: a.id,
    sessionId: s.id,
    role: 'user',
    body: '下次继续',
    clientId: 'test-1',
  });
  assert.equal((await call('session_read', { spaceId: a.id, sessionId: s.id })).messages.length, 1);
  const missingKey = await call('chat_reply', {
    spaceId: a.id,
    sessionId: s.id,
    body: '你好',
    clientId: 'test-2',
  });
  assert.equal(missingKey.isError, true);
  assert.match(missingKey.content[0].text, /还没配置/);
});
