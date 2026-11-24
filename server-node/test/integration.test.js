import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { get } from 'node:https';
import { rootCertificates, connect as tlsConnect } from 'node:tls';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { createService, limits } from '../src/service.js';
import { defaultCertDirectory } from '../src/tls.js';
import { temporaryAccounts } from './helpers.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const ca = readFileSync(join(defaultCertDirectory, 'public/dev-ca.crt'));
const bounded = async (promise, ms = 5000) => {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Test deadline exceeded')), ms); })]); }
  finally { clearTimeout(timer); }
};
async function start(options) {
  const accounts = temporaryAccounts();
  const service = createService({ accountStore: accounts.store, ...options });
  let cleaned = false;
  service.server.listen(0, '127.0.0.1');
  await once(service.server, 'listening');
  return { ...service, port: service.server.address().port, stop: async () => {
    await service.stop();
    if (!cleaned) { cleaned = true; accounts.cleanup(); }
  } };
}
function httpsGet(port, options = {}) {
  return new Promise((resolveGet, reject) => {
    const request = get({ hostname: '127.0.0.1', port, path: '/health', ca, ...options }, (response) => {
      let body = '';
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => resolveGet({ status: response.statusCode, body: JSON.parse(body) }));
    });
    request.on('error', reject);
    request.setTimeout(5000, () => request.destroy(new Error('HTTPS timeout')));
  });
}
async function peer(port, options = {}) {
  const ws = new WebSocket(`wss://127.0.0.1:${port}/ws`, { ca, perMessageDeflate: false, handshakeTimeout: 5000, ...options });
  const messages = [];
  const waiting = [];
  const closed = new Promise((resolveClose) => ws.once('close', (code) => resolveClose(code)));
  ws.on('message', (raw) => {
    const value = JSON.parse(raw.toString());
    if (waiting.length) waiting.shift()(value); else messages.push(value);
  });
  const next = () => bounded(messages.length ? Promise.resolve(messages.shift()) : new Promise((resolveNext) => waiting.push(resolveNext)));
  ws.on('error', () => {});
  await bounded(once(ws, 'open'));
  const hello = await next();
  assert.equal(hello.type, 'HELLO');
  assert.equal(ws.extensions, '');
  return { ws, next, hello, closed };
}
async function echo(client, text) {
  const requestId = randomUUID();
  client.ws.send(JSON.stringify({ version: 1, type: 'ECHO', requestId, data: { text } }));
  const reply = await client.next();
  assert.deepEqual(reply, { version: 1, type: 'ECHO_RESULT', requestId, data: { text }, connectionId: client.hello.connectionId });
}

test('HTTPS trust, hostname, TLS floor and invalid startup fail closed', async (t) => {
  const service = await start();
  t.after(() => service.stop());
  assert.deepEqual(await httpsGet(service.port), { status: 200, body: { status: 'ok', service: 'SecureFileTransfer.Server', stage: 'EnhancedV1', softwareVersion: '4.0.0', capabilities: ['window-auth-v1', 'resume-v1', 'account-bandwidth-v1'] } });
  await assert.rejects(httpsGet(service.port, { ca: undefined }));
  await assert.rejects(httpsGet(service.port, { ca: rootCertificates[0] }));
  await assert.rejects(httpsGet(service.port, { servername: 'mismatch.invalid' }));
  const tls12 = tlsConnect({ host: '127.0.0.1', port: service.port, ca, minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2' });
  await once(tls12, 'secureConnect');
  assert.equal(tls12.getProtocol(), 'TLSv1.2');
  tls12.destroy();
  await assert.rejects(httpsGet(service.port, { minVersion: 'TLSv1', maxVersion: 'TLSv1.1' }));
  const temporary = mkdtempSync(join(tmpdir(), 'sft-p02-invalid-'));
  try {
    for (const invalid of [false, true]) {
      if (invalid) {
        mkdirSync(join(temporary, 'public'));
        mkdirSync(join(temporary, 'private'));
        writeFileSync(join(temporary, 'public/server.crt'), 'invalid certificate');
        writeFileSync(join(temporary, 'public/dev-ca.crt'), 'invalid CA');
        writeFileSync(join(temporary, 'private/server.key'), 'invalid key');
      }
      const result = spawnSync(process.execPath, ['src/server.js'], { cwd: root, env: { ...process.env, SFT_CERT_DIR: temporary }, encoding: 'utf8', timeout: 5000, windowsHide: true });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /TLS certificates missing or invalid/);
      assert.doesNotMatch(result.stdout, /Listening/);
    }
  } finally {
    if (dirname(resolve(temporary)) === resolve(tmpdir()) && basename(temporary).startsWith('sft-p02-invalid-')) rmSync(temporary, { recursive: true, force: true });
  }
});

test('persistent ECHO, isolation, fragmentation, invalid messages and limits', async (t) => {
  const service = await start();
  t.after(() => service.stop());
  const a = await peer(service.port);
  const b = await peer(service.port);
  assert.notEqual(a.hello.connectionId, b.hello.connectionId);
  for (let i = 0; i < 3; i++) await Promise.all([echo(a, `A-${i}`), echo(b, `B-${i}`)]);
  const requestId = randomUUID();
  const body = JSON.stringify({ version: 1, type: 'ECHO', requestId, data: { text: 'fragmented 中文' } });
  a.ws.send(body.slice(0, 30), { fin: false });
  a.ws.send(body.slice(30), { fin: true });
  assert.equal((await a.next()).requestId, requestId);
  a.ws.send('{');
  assert.equal((await a.next()).code, 'INVALID_JSON');
  for (const invalid of [null, [], { version: 1, type: 'UNKNOWN' }, { version: '1', type: 'ECHO', requestId, data: { text: 'x' } }, { version: 1, type: 'ECHO', requestId: 3, data: { text: 'x' } }, { version: 1, type: 'ECHO', requestId, data: { text: 'x'.repeat(1025) } }]) {
    a.ws.send(JSON.stringify(invalid));
    assert.equal((await a.next()).code, 'INVALID_MESSAGE');
  }
  await echo(a, 'still alive after errors');
  const binary = await peer(service.port);
  // P2 accepts only well-formed authenticated upload blocks; this remains malformed.
  binary.ws.send(Buffer.from([1, 2, 3]));
  assert.equal(await bounded(binary.closed), 1003);
  const oversized = await peer(service.port);
  oversized.ws.send('x'.repeat(limits.messageBytes + 1));
  assert.equal(await bounded(oversized.closed), 1009);
  a.ws.close(1000);
  assert.equal(await bounded(a.closed), 1000);
  const reconnect = await peer(service.port);
  assert.notEqual(reconnect.hello.connectionId, a.hello.connectionId);
  await echo(reconnect, 'reconnected');
  await echo(b, 'B unaffected');
  await service.stop();
  assert.equal(await bounded(b.closed), 1001);
  assert.equal(service.wss.clients.size, 0);
  const probe = net.createServer().listen(service.port, '127.0.0.1');
  await once(probe, 'listening');
  await new Promise((resolveClose) => probe.close(resolveClose));
});

test('connection cap rejects excess clients and allows reuse after cleanup', async (t) => {
  const service = await start();
  t.after(() => service.stop());
  const clients = [];
  for (let i = 0; i < limits.connections; i++) clients.push(await peer(service.port));
  await assert.rejects(peer(service.port), /503/);
  clients[0].ws.close();
  await clients[0].closed;
  const replacement = await peer(service.port);
  await echo(replacement, 'slot reused');
});

test('real 61-second idle remains usable; missing protocol PONG is cleaned within 30 seconds', { timeout: 75000 }, async (t) => {
  const service = await start();
  t.after(() => service.stop());
  const healthy = await peer(service.port);
  const silent = await peer(service.port, { autoPong: false });
  let pings = 0;
  healthy.ws.on('ping', () => pings++);
  const began = Date.now();
  console.log('Idle acceptance started: 61 seconds, no application ECHO traffic.');
  await Promise.all([delay(61000), bounded(silent.closed, 30000)]);
  assert.ok(Date.now() - began >= 60000);
  assert.ok(pings >= 3);
  await echo(healthy, 'after real idle');
  assert.equal(service.wss.clients.size, 1);
  console.log(`Idle acceptance passed; protocol PING count=${pings}; original connectionId unchanged.`);
});

test('bounded shutdown destroys a peer that ignores close and clears its state', async () => {
  const service = await start({ shutdownMs: 300 });
  const client = await peer(service.port);
  client.ws.pause();
  const began = Date.now();
  await bounded(service.stop(), 2500);
  assert.ok(Date.now() - began < 2000);
  assert.equal(service.wss.clients.size, 0);
  client.ws.terminate();
});
