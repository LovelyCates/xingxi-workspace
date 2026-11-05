import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { get, request as httpRequest, createServer as createHttpServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Store } from '../server/store.mjs';
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
  for (const invalid of ['null', '[]', '42']) {
    assert.equal(
      (await fetch(`${base}/api/spaces`, { method: 'POST', headers, body: invalid })).status,
      400,
    );
  }
  // A UTF-8 character split between TCP writes must survive ingestion unchanged.
  const payload = Buffer.from(JSON.stringify({ name: '分块中文' }));
  const split = payload.indexOf(Buffer.from('中')) + 1;
  const chunked = await new Promise((resolve, reject) => {
    const req = httpRequest(`${base}/api/spaces`, { method: 'POST', headers }, (res) => {
      let body = '';
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve(JSON.parse(body)));
    });
    req.on('error', reject);
    req.write(payload.subarray(0, split));
    setTimeout(() => req.end(payload.subarray(split)), 10);
  });
  assert.equal(chunked.name, '分块中文');
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
  assert.equal((await call('space_list')).length, 3);
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
  const view = await (
    await fetch(`${base}/api/spaces/${a.id}/view?view=book&filter=pending`, { headers })
  ).json();
  assert.equal(view.entries[0].id, good.id);
  assert.equal(view.entries[0].body, undefined);
  assert.equal(view.counts.pending, 1);
  const detail = await (
    await fetch(`${base}/api/spaces/${a.id}/entries/${good.id}/detail`, { headers })
  ).json();
  assert.equal(detail.body, good.body);
  assert.equal(detail.sourceSummaries[0].id, source.id);
  assert.equal(
    (await fetch(`${base}/api/spaces/${b.id}/entries/${good.id}/detail`, { headers })).status,
    404,
  );
  assert.equal(
    (await fetch(`${base}/api/spaces/${a.id}/view?view=book&after=malformed`, { headers })).status,
    400,
  );

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
  const evidenceTool = list.tools.find((x) => x.name === 'chat_evidence');
  assert.equal(evidenceTool.annotations.readOnlyHint, true);
  const manualReply = await call('session_append', {
    spaceId: a.id,
    sessionId: s.id,
    role: 'assistant',
    body: '这是集成测试写入的虚构回复，不是模型回答。',
    clientId: 'fixture-reply',
  });
  assert.equal(
    (await call('chat_evidence', { spaceId: a.id, sessionId: s.id, messageId: manualReply.id }))
      .recorded,
    false,
  );
  // A deterministic fixture supplies stored audit data; no cloud model is called.
  const fixtureStore = new Store(join(dir, 'xingxi.sqlite'));
  try {
    const firstMessage = fixtureStore.session(a.id, s.id).messages[0];
    fixtureStore.replyEvidence.save(a.id, s.id, manualReply.id, {
      model: 'fixture-only',
      knowledge: [],
      conversation: [],
      recent: [
        { id: firstMessage.id, role: firstMessage.role, created_at: firstMessage.created_at },
      ],
    });
  } finally {
    fixtureStore.close();
  }
  const mcpEvidence = await call('chat_evidence', {
    spaceId: a.id,
    sessionId: s.id,
    messageId: manualReply.id,
  });
  const browserEvidence = await (
    await fetch(`${base}/api/spaces/${a.id}/sessions/${s.id}/messages/${manualReply.id}/evidence`, {
      headers,
    })
  ).json();
  assert.deepEqual(mcpEvidence, browserEvidence);
  assert.equal(mcpEvidence.recorded, true);
  assert.equal(mcpEvidence.items.length, 1);
  assert.equal(
    (await call('chat_evidence', { spaceId: b.id, sessionId: s.id, messageId: manualReply.id }))
      .isError,
    true,
  );
  assert.equal(
    (
      await fetch(
        `${base}/api/spaces/${b.id}/sessions/${s.id}/messages/${manualReply.id}/evidence`,
        { headers },
      )
    ).status,
    404,
  );
  const missingKey = await call('chat_reply', {
    spaceId: a.id,
    sessionId: s.id,
    body: '你好',
    clientId: 'test-2',
  });
  assert.equal(missingKey.isError, true);
  assert.match(missingKey.content[0].text, /还没配置/);
  const browserSession = await (
    await fetch(`${base}/api/spaces/${a.id}/session-open`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ binding: 'shared', title: 'Web and MCP' }),
    })
  ).json();
  const mcpSession = await call('session_open', { spaceId: a.id, binding: 'shared' });
  assert.equal(browserSession.id, mcpSession.id);
  await call('session_append', {
    spaceId: a.id,
    sessionId: mcpSession.id,
    role: 'user',
    body: '虚构联调：纸舟计划周五完成',
    clientId: 'memory',
  });
  assert.equal(
    (await call('conversation_recall', { spaceId: a.id, query: '纸舟' })).excerpts.length,
    1,
  );
  assert.equal(
    (await call('conversation_recall', { spaceId: b.id, query: '纸舟' })).excerpts.length,
    0,
  );
  assert.ok(
    (await call('session_list', { spaceId: a.id })).sessions.some(
      (x) => x.id === browserSession.id,
    ),
  );
  assert.equal(
    (
      await fetch(`${base}/api/spaces/${a.id}/sessions/${mcpSession.id}`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ recallEnabled: false }),
      })
    ).status,
    200,
  );
  assert.equal(
    (await call('conversation_recall', { spaceId: a.id, query: '纸舟' })).excerpts.length,
    0,
  );
  assert.equal(
    (
      await fetch(`${base}/api/spaces/${a.id}/sessions/${mcpSession.id}`, {
        method: 'DELETE',
        headers,
      })
    ).status,
    200,
  );
  assert.equal(
    (await call('session_read', { spaceId: a.id, sessionId: mcpSession.id })).isError,
    true,
  );
  const bound = await call('session_open', { spaceId: a.id, binding: 'restore-continuity' });
  await call('session_append', {
    spaceId: a.id,
    sessionId: bound.id,
    role: 'user',
    body: '虚构验收：恢复后仍有银杏标记。',
    clientId: 'restored-memory',
  });
  const backupStart = await fetch(`${base}/api/backups`, { method: 'POST', headers, body: '{}' });
  assert.equal(backupStart.status, 202);
  let backupStatus;
  for (let attempt = 0; attempt < 100; attempt++) {
    backupStatus = await (await fetch(`${base}/api/backups`, { headers })).json();
    if (backupStatus.active.status !== 'running') break;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(backupStatus.active.status, 'done');
  assert.equal(backupStatus.items.length, 1);
  const item = backupStatus.items[0];
  assert.equal(item.includesSecrets, false);
  assert.equal((await fetch(`${base}/api/backups`)).status, 401);
  assert.equal(
    (
      await fetch(`${base}/api/backups`, {
        method: 'POST',
        headers: { ...headers, Origin: 'https://evil.example' },
        body: '{}',
      })
    ).status,
    403,
  );
  assert.equal(
    (await fetch(`${base}/api/backups/invalid/restore`, { method: 'POST', headers, body: '{}' }))
      .status,
    400,
  );
  assert.equal(
    (await fetch(`${base}/api/backups/${item.id}/restore`, { method: 'POST', headers, body: '{}' }))
      .status,
    202,
  );
  for (let attempt = 0; attempt < 100; attempt++) {
    backupStatus = await (await fetch(`${base}/api/backups`, { headers })).json();
    if (backupStatus.active.status !== 'running') break;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(backupStatus.active.status, 'done');
  const restoredDir = backupStatus.active.result.path;
  // Check exact IDs before starting the independent restored service.
  const restoredStore = new Store(join(restoredDir, 'xingxi.sqlite'));
  try {
    assert.deepEqual(restoredStore.replyEvidence.read(a.id, s.id, manualReply.id), mcpEvidence);
    assert.equal(restoredStore.session(a.id, s.id).messages.length, 2);
  } finally {
    restoredStore.close();
  }
  const restoreProbe = createServer();
  await new Promise((r) => restoreProbe.listen(0, '127.0.0.1', r));
  const restorePort = restoreProbe.address().port;
  await new Promise((r) => restoreProbe.close(r));
  const recovered = spawn(process.execPath, ['server/http.mjs'], {
    cwd: resolve('.'),
    env: { ...env, XINGXI_DATA_DIR: restoredDir, PORT: String(restorePort) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const recoveredClient = new Client({ name: 'restore-test', version: '1.0' });
  try {
    await Promise.race([
      once(recovered.stdout, 'data'),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('恢复服务未启动')), 8000).unref(),
      ),
    ]);
    await recoveredClient.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [resolve('server/mcp.mjs')],
        env: {
          ...env,
          XINGXI_DATA_DIR: restoredDir,
          XINGXI_URL: `http://127.0.0.1:${restorePort}`,
        },
        stderr: 'pipe',
      }),
    );
    const recoverCall = async (name, arguments_) => {
      const result = await recoveredClient.callTool({ name, arguments: arguments_ });
      assert.ok(!result.isError, result.content[0].text);
      return JSON.parse(result.content[0].text);
    };
    assert.equal(
      (await recoverCall('session_open', { spaceId: a.id, binding: 'restore-continuity' })).id,
      bound.id,
    );
    assert.equal(
      (await recoverCall('conversation_recall', { spaceId: a.id, query: '银杏' })).excerpts.length,
      1,
    );
    assert.deepEqual(
      await recoverCall('chat_evidence', {
        spaceId: a.id,
        sessionId: s.id,
        messageId: manualReply.id,
      }),
      mcpEvidence,
    );
    assert.notEqual(readFileSync(join(restoredDir, 'access-token'), 'utf8'), token);
  } finally {
    await recoveredClient.close();
    const exit = once(recovered, 'exit');
    recovered.kill('SIGTERM');
    await exit;
  }
  const policy = (await fetch(`${base}/api/spaces`, { headers })).headers.get(
    'content-security-policy',
  );
  assert.ok(policy.includes("connect-src 'self'"));
});

test('MCP refuses HTTP redirects without contacting the target', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'xingxi-redirect-'));
  writeFileSync(join(dir, 'access-token'), 'test-local-token');
  let targetRequests = 0;
  const target = createHttpServer((req, res) => {
    targetRequests++;
    res.end('{}');
  });
  await new Promise((r) => target.listen(0, '127.0.0.1', r));
  const redirector = createHttpServer((req, res) => {
    res.writeHead(307, { Location: `http://127.0.0.1:${target.address().port}/leak` });
    res.end();
  });
  await new Promise((r) => redirector.listen(0, '127.0.0.1', r));
  const client = new Client({ name: 'redirect-test', version: '1.0' });
  t.after(async () => {
    await client.close();
    await Promise.all([
      new Promise((r) => target.close(r)),
      new Promise((r) => redirector.close(r)),
    ]);
    rmSync(dir, { recursive: true, force: true });
  });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [resolve('server/mcp.mjs')],
      env: {
        ...process.env,
        XINGXI_DATA_DIR: dir,
        XINGXI_URL: `http://localhost:${redirector.address().port}`,
      },
      stderr: 'pipe',
    }),
  );
  const result = await client.callTool({ name: 'space_list', arguments: {} });
  assert.equal(result.isError, true);
  assert.equal(targetRequests, 0);
  assert.ok(!JSON.stringify(result).includes('test-local-token'));
});
