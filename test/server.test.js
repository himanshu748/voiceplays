import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chmodSync } from 'node:fs';

// End-to-end over Streamable HTTP with a fake `rote` first on PATH.
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 18000 + Math.floor(Math.random() * 1000);
const TOKEN = 'x'.repeat(40);
const ID = 'client-id', SECRET = 's'.repeat(40), PUBLIC = `http://127.0.0.1:${PORT}`;
let server;

before(async () => {
  // Git hosts and the contents API do not always keep the executable bit.
  chmodSync(path.join(root, 'test/fixtures/rote'), 0o755);
  server = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: {
      ...process.env,
      PATH: `${path.join(root, 'test/fixtures')}${path.delimiter}${process.env.PATH}`,
      PORT: String(PORT), VOICEPLAYS_TOKEN: TOKEN,
      VOICEPLAYS_CLIENT_ID: ID, VOICEPLAYS_CLIENT_SECRET: SECRET, PUBLIC_URL: PUBLIC,
      VOICEPLAYS_ALLOW_WRITES: 'restart-nginx'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  await new Promise((resolve, reject) => {
    server.stdout.on('data', d => String(d).includes('MCP server on') && resolve());
    server.on('exit', code => reject(new Error(`server exited ${code}`)));
  });
});

after(() => server?.kill());

async function call(name, args, token = TOKEN) {
  const res = await fetch(`${PUBLIC}/mcp`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
  });
  if (res.status !== 200) return { status: res.status };
  const text = await res.text();
  const json = JSON.parse(text.startsWith('{') ? text : text.split('\n').find(l => l.startsWith('data:')).slice(5));
  return { status: 200, text: json.result.content[0].text, isError: Boolean(json.result.isError) };
}

test('rejects requests without a valid bearer token', async () => {
  assert.equal((await call('find_procedure', { phrase: 'disk' }, 'nope')).status, 401);
});

test('find_procedure ranks and flags non-read-only plays', async () => {
  const r = await call('find_procedure', { phrase: 'restart nginx web server' });
  assert.match(r.text, /restart-nginx \(not marked read-only\)/);
});

test('read-only local play starts, then reports a spoken summary without terminal decoration', async () => {
  assert.match((await call('start_procedure', { name: 'disk-space' })).text, /^Started disk-space/);
  let r;
  for (let i = 0; i < 20; i++) {
    r = await call('procedure_result', { name: 'disk-space' });
    if (!/still running/.test(r.text)) break;
    await new Promise(res => setTimeout(res, 100));
  }
  assert.match(r.text, /finished in \d+ seconds\. step 1, Filesystem \/dev\/sda1 has 42 GB free/);
});

test('refuses plays with required params and unapproved registry plays', async () => {
  assert.match((await call('start_procedure', { name: 'deploy' })).text, /needs service/);
  assert.match((await call('start_procedure', { name: 'weather' })).text, /registry/);
});

test('allowlisted write play needs the confirmation code on a second turn', async () => {
  const first = await call('start_procedure', { name: 'restart-nginx' });
  assert.ok(first.isError);
  const code = first.text.match(/code (\d{4})/)[1];
  assert.ok((await call('start_procedure', { name: 'restart-nginx', confirmation: code === '0000' ? '1111' : '0000' })).isError);
  // The wrong code re-issued a fresh one; use the newest.
  const again = await call('start_procedure', { name: 'restart-nginx' });
  const fresh = again.text.match(/code (\d{4})/)[1];
  assert.match((await call('start_procedure', { name: 'restart-nginx', confirmation: fresh })).text, /^Started restart-nginx/);
});

test('OAuth client_credentials issues a token that works on /mcp', async () => {
  const basic = Buffer.from(`${ID}:${SECRET}`).toString('base64');
  const res = await fetch(`${PUBLIC}/oauth/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'mcp:service', resource: `${PUBLIC}/mcp` })
  });
  assert.equal(res.status, 200);
  const { access_token } = await res.json();
  assert.equal((await call('find_procedure', { phrase: 'disk' }, access_token)).status, 200);
});

test('malformed percent-encoding in Basic credentials is a 401, not a 500', async () => {
  const basic = Buffer.from('%E0%A4%A:%').toString('base64');
  const res = await fetch(`${PUBLIC}/oauth/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials'
  });
  assert.equal(res.status, 401);
});
