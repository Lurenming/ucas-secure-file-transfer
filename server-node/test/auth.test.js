import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { get } from 'node:https';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { createService } from '../src/service.js';
import { createAccount, validPassword, scryptParameters } from '../src/passwords.js';
import { openAccounts, normalizeUsername } from '../src/accounts.js';
import { AuthManager } from '../src/auth.js';
import { defaultCertDirectory } from '../src/tls.js';
import { temporaryAccounts } from './helpers.js';

const ca = readFileSync(join(defaultCertDirectory, 'public/dev-ca.crt'));
const secret = () => randomBytes(24).toString('base64url');
async function until(predicate, timeout = 5000) {
  const deadline = performance.now() + timeout;
  while (!predicate()) { if (performance.now() > deadline) throw new Error('Condition timed out'); await delay(10); }
}
async function fixture(t, authOptions = {}) {
  const accounts = temporaryAccounts();
  const service = createService({ accountStore: accounts.store, authOptions });
  service.server.listen(0, '127.0.0.1');
  await once(service.server, 'listening');
  t.after(async () => { await service.stop(); await until(() => service.authentication.active === 0); accounts.cleanup(); });
  return { ...accounts, ...service, port: service.server.address().port };
}
async function peer(port) {
  const ws = new WebSocket(`wss://127.0.0.1:${port}/ws`, { ca, perMessageDeflate: false });
  const queue = [];
  const waiters = [];
  const wire = [];
  const closed = new Promise(resolve => ws.once('close', code => resolve(code)));
  ws.on('error', () => {});
  ws.on('message', raw => {
    wire.push(raw.toString());
    const value = JSON.parse(raw);
    if (waiters.length) waiters.shift()(value); else queue.push(value);
  });
  const next = async () => {
    let timer;
    try {
      return await Promise.race([queue.length ? Promise.resolve(queue.shift()) : new Promise(resolve => waiters.push(resolve)),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Reply timeout')), 10000); })]);
    } finally { clearTimeout(timer); }
  };
  const hello = await next();
  assert.equal(hello.type, 'HELLO');
  const send = (type, data = {}) => {
    const requestId = randomUUID();
    ws.send(JSON.stringify({ version: 1, type, requestId, data }));
    return requestId;
  };
  return { ws, next, hello, closed, wire, send, request: async (type, data = {}) => {
    const requestId = send(type, data);
    const reply = await next();
    assert.equal(reply.requestId, requestId);
    return reply;
  } };
}
const login = (client, username, password) => client.request('AUTH_LOGIN', { username, password });
function noSecrets(wire, values) {
  const text = wire.join('\n');
  assert.ok(values.every(value => !text.includes(value)), 'Responses do not contain authentication secrets');
  assert.ok(!/"(password|password_hash|salt|algorithm|maxmem)"\s*:/.test(text), 'Responses expose no credential fields');
}

test('SQLite persistence, normalization, unique salts, fixed parameters and password boundaries', async () => {
  const accounts = temporaryAccounts();
  const password = secret();
  let reopened;
  try {
    const began = performance.now();
    await createAccount(accounts.store, 'Alice', password);
    const firstMs = performance.now() - began;
    const secondStart = performance.now();
    await createAccount(accounts.store, 'bob', password);
    const secondMs = performance.now() - secondStart;
    const a = accounts.store.findByUsername('alice');
    const b = accounts.store.findByUsername('bob');
    assert.ok(!Buffer.from(a.salt).equals(b.salt), 'Independent salts');
    assert.ok(!Buffer.from(a.password_hash).equals(b.password_hash), 'Independent saved hashes');
    assert.equal(a.salt.length, 16);
    assert.equal(a.n, scryptParameters.N);
    assert.equal(a.maxmem, scryptParameters.maxmem);
    assert.equal(a.key_length, 64);
    await assert.rejects(createAccount(accounts.store, 'ALICE', secret()), /已存在/);
    assert.equal(accounts.store.findByUsername("alice' OR 1=1 --"), undefined);
    assert.throws(() => normalizeUsername(' alice'));
    assert.throws(() => normalizeUsername('Ａlice'));
    assert.ok(!validPassword('x'.repeat(11)) && !validPassword('x'.repeat(257)));
    assert.ok(validPassword(' '.repeat(12)) && !validPassword('\ud800'.repeat(12)));
    accounts.store.close();
    reopened = openAccounts(join(accounts.directory, 'data'));
    assert.equal(reopened.findByUsername('alice').user_id, a.user_id);
    assert.ok(Buffer.from(reopened.findByUsername('alice').password_hash).equals(a.password_hash), 'Reopen preserves hash');
    console.log(`scrypt N=131072,r=8,p=1,keyLength=64 measured ${firstMs.toFixed(1)} ms and ${secondMs.toFixed(1)} ms; secret values withheld.`);
  } finally { reopened?.close(); accounts.cleanup(); }
});

test('WSS identities, uniform failures, spoof prevention, logout and reconnect', async (t) => {
  const f = await fixture(t, { failureDelayMs: 0 });
  const password = secret();
  await createAccount(f.store, 'alice', password);
  await createAccount(f.store, 'bob', password);
  const a = await peer(f.port);
  const b = await peer(f.port);
  assert.equal((await a.request('AUTH_ME')).code, 'AUTH_REQUIRED');
  const wrong = await login(a, 'alice', secret());
  const missing = await login(b, 'nobody', secret());
  assert.equal(wrong.code, 'AUTH_FAILED');
  assert.equal(wrong.message, '用户名或密码错误');
  assert.equal(missing.code, wrong.code);
  assert.equal(missing.message, wrong.message);
  const [alice, bob] = await Promise.all([login(a, 'ALICE', password), login(b, 'bob', password)]);
  assert.equal(alice.type, 'AUTH_LOGIN_RESULT');
  assert.equal(bob.type, 'AUTH_LOGIN_RESULT');
  assert.notEqual(alice.data.userId, bob.data.userId);
  assert.equal((await a.request('AUTH_ME', { userId: bob.data.userId })).data.userId, alice.data.userId);
  assert.equal((await b.request('AUTH_ME')).data.username, 'bob');
  assert.equal((await login(a, 'bob', password)).code, 'AUTH_ALREADY_LOGGED_IN');
  assert.equal((await a.request('AUTH_LOGOUT')).type, 'AUTH_LOGOUT_RESULT');
  assert.equal((await a.request('AUTH_ME')).code, 'AUTH_REQUIRED');
  assert.equal((await login(a, 'alice', password)).type, 'AUTH_LOGIN_RESULT');
  a.ws.close(); await a.closed;
  const reconnect = await peer(f.port);
  assert.equal((await reconnect.request('AUTH_ME')).code, 'AUTH_REQUIRED');
  assert.equal((await login(reconnect, "alice' OR 1=1 --", password)).code, 'INVALID_MESSAGE');
  const record = f.store.findByUsername('alice');
  noSecrets([...a.wire, ...b.wire, ...reconnect.wire], [password, Buffer.from(record.password_hash).toString('hex'), Buffer.from(record.password_hash).toString('base64')]);
});

test('one login per connection; logout/disconnect invalidate in-flight results', async (t) => {
  const f = await fixture(t);
  const password = secret();
  await createAccount(f.store, 'alice', password);
  const a = await peer(f.port);
  const firstId = a.send('AUTH_LOGIN', { username: 'alice', password });
  const secondId = a.send('AUTH_LOGIN', { username: 'alice', password });
  const busy = await a.next();
  assert.equal(busy.requestId, secondId);
  assert.equal(busy.code, 'AUTH_BUSY');
  await delay(20);
  const logoutId = a.send('AUTH_LOGOUT');
  const results = [await a.next(), await a.next()];
  assert.equal(results.find(x => x.requestId === logoutId).type, 'AUTH_LOGOUT_RESULT');
  assert.equal(results.find(x => x.requestId === firstId).code, 'AUTH_CANCELLED');
  assert.equal((await a.request('AUTH_ME')).code, 'AUTH_REQUIRED');
  a.send('AUTH_LOGIN', { username: 'alice', password });
  await until(() => f.authentication.active > 0);
  a.ws.terminate(); await a.closed;
  await until(() => f.authentication.active === 0);
  const next = await peer(f.port);
  assert.equal((await next.request('AUTH_ME')).code, 'AUTH_REQUIRED');
  assert.equal((await login(next, 'alice', password)).type, 'AUTH_LOGIN_RESULT');
});

test('session expiry permits same-connection login; ECHO and logout cannot extend unauthenticated wait', async (t) => {
  const f = await fixture(t, { sessionMs: 120, unauthenticatedMs: 2000 });
  const password = secret();
  await createAccount(f.store, 'alice', password);
  const a = await peer(f.port);
  assert.equal((await login(a, 'alice', password)).type, 'AUTH_LOGIN_RESULT');
  assert.equal((await a.next()).type, 'AUTH_EXPIRED');
  assert.equal((await a.request('AUTH_ME')).code, 'AUTH_REQUIRED');
  assert.equal((await login(a, 'alice', password)).type, 'AUTH_LOGIN_RESULT');
  a.ws.close(); await a.closed;
  const short = await fixture(t, { unauthenticatedMs: 200 });
  const waiting = await peer(short.port);
  const interval = setInterval(() => {
    if (waiting.ws.readyState === WebSocket.OPEN) {
      waiting.send('ECHO', { text: 'diagnostic' });
      waiting.send('AUTH_LOGOUT');
    }
  }, 30);
  try { assert.equal(await waiting.closed, 1008); } finally { clearInterval(interval); }
});

test('failed-attempt backoff, connection and global attempt budgets run before KDF', async (t) => {
  const f = await fixture(t, { failureDelayMs: 500, globalBurst: 2, connectionBurst: 1 });
  const a = await peer(f.port);
  assert.equal((await login(a, 'missing', secret())).code, 'AUTH_FAILED');
  assert.equal((await login(a, 'missing', secret())).code, 'AUTH_RATE_LIMITED');
  const b = await peer(f.port);
  assert.equal((await login(b, 'missing', secret())).code, 'AUTH_FAILED');
  const c = await peer(f.port);
  assert.equal((await login(c, 'missing', secret())).code, 'AUTH_RATE_LIMITED');
  assert.equal(f.authentication.active, 0);
  assert.equal(f.authentication.queue.length, 0);
});

test('bounded real scrypt load leaves HTTPS and protocol control traffic responsive', async (t) => {
  const f = await fixture(t);
  const clients = [];
  for (let i = 0; i < 7; i++) clients.push(await peer(f.port));
  for (const client of clients) client.send('AUTH_LOGIN', { username: 'missing', password: secret() });
  assert.equal((await clients[6].next()).code, 'AUTH_SERVER_BUSY');
  assert.ok(f.authentication.active <= 2 && f.authentication.queue.length <= 4);
  const began = performance.now();
  await new Promise((resolve, reject) => {
    get(`https://127.0.0.1:${f.port}/health`, { ca }, response => { response.resume(); response.on('end', resolve); }).on('error', reject);
  });
  const healthMs = performance.now() - began;
  assert.ok(healthMs < 1000, 'Health request stays responsive during real scrypt');
  const pong = once(clients[6].ws, 'pong');
  clients[6].ws.ping('responsive');
  await pong;
  clients[5].ws.terminate(); await clients[5].closed;
  await until(() => f.authentication.queue.length <= 3);
  for (const client of clients) client.ws.terminate();
  await until(() => f.authentication.active === 0);
  console.log(`HTTPS under scrypt load: ${healthMs.toFixed(1)} ms; concurrency <= 2 and queue <= 4.`);
});

test('queue cancellation, admission cap, wait deadline and shutdown cleanup are bounded', async () => {
  const manager = new AuthManager(null, { maxActive: 1, maxQueued: 1, queueWaitMs: 30 });
  let release;
  const running = manager.run(() => new Promise(resolve => { release = resolve; }), new AbortController().signal);
  await delay(0);
  const cancellation = new AbortController();
  const waiting = manager.run(() => {}, cancellation.signal);
  const rejected = assert.rejects(manager.run(() => {}, new AbortController().signal), /AUTH_SERVER_BUSY/);
  const cancelled = assert.rejects(waiting, /AUTH_CANCELLED/);
  cancellation.abort();
  await Promise.all([rejected, cancelled]);
  assert.equal(manager.queue.length, 0);
  await assert.rejects(manager.run(() => {}, new AbortController().signal), /AUTH_SERVER_BUSY/);
  const closing = manager.run(() => {}, new AbortController().signal);
  const onClose = assert.rejects(closing, /AUTH_CANCELLED/);
  manager.close();
  await onClose;
  release(); await running;
  await until(() => manager.active === 0);
  assert.equal(manager.queue.length, 0);
});
