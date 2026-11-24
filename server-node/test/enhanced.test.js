import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, X509Certificate } from 'node:crypto';
import { once } from 'node:events';
import { fork, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { get } from 'node:https';
import { WebSocket } from 'ws';
import { fixture, logged, peer, upload, digest, delay, until, ca } from './upload-fixture.js';
import { temporaryAccounts } from './helpers.js';
import { createAccount } from '../src/passwords.js';
import { loadTlsOptions, defaultCertDirectory } from '../src/tls.js';
import { listenConfig } from '../src/connection-config.js';

async function openResume(p, data, name = 'resume.bin') {
  const reply = await p.request('UPLOAD_OPEN', { name, size: data.length, sha256: digest(data) });
  assert.equal(reply.type, 'UPLOAD_OPEN_RESULT'); return reply.data.uploadId;
}
async function finish(p, id, bytes, offset = 0) {
  for (let at = offset; at < bytes.length; at += 8192) assert.equal((await p.chunk(id, at, bytes.subarray(at, at + 8192))).type, 'UPLOAD_CHUNK_RESULT');
  const reply = await p.request('UPLOAD_COMPLETE', { uploadId: id, sha256: digest(bytes) });
  assert.equal(reply.type, 'UPLOAD_COMPLETE_RESULT'); return reply.data;
}
async function health(port) {
  return new Promise((resolve, reject) => {
    get({ hostname: '127.0.0.1', port, path: '/health', ca }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); }).on('error', reject);
  });
}

test('explicit LAN configuration and capability negotiation, bounded default sixteen transfers', async t => {
  assert.deepEqual(listenConfig({}), { host: '127.0.0.1', port: 8443 });
  assert.throws(() => listenConfig({ SFT_LISTEN_HOST: '0.0.0.0' }), /SFT_ALLOW_LAN/);
  assert.equal(listenConfig({ SFT_LISTEN_HOST: '0.0.0.0', SFT_ALLOW_LAN: '1', SFT_PORT: '9443' }).port, 9443);
  const f = await fixture(t), control = await logged(f);
  assert.ok(control.hello.data.capabilities.includes('resume-v1'));
  const peers = [control];
  for (let i = 0; i < 16; i++) {
    // Independent authenticated windows avoid one-window 8-worker bound.
    const p = await peer(f.port); peers.push(p);
    const ticket = (await control.request('AUTH_WINDOW')).data.ticket;
    if (i < 8) assert.equal((await p.request('AUTH_ATTACH', { ticket })).type, 'AUTH_ATTACH_RESULT');
    else {
      // Admission of a ninth member is explicitly rejected; close it without growing state.
      assert.equal((await p.request('AUTH_ATTACH', { ticket })).code, 'AUTH_FAILED'); p.ws.close(); break;
    }
  }
  assert.equal(f.uploadStore.policy.maxActive, 16);
  const owner = control.identity.userId, held = [];
  for (let i = 0; i < 16; i++) held.push(f.uploadStore.reserve(owner, randomUUID(), 0, 'limit', 0));
  assert.throws(() => f.uploadStore.reserve(owner, randomUUID(), 0, 'limit', 0), /UPLOAD_LIMIT/);
  for (const item of held) await f.uploadStore.discard(item);
});

test('window tickets authenticate every member, logout closes only its group; no username spoof', async t => {
  const f = await fixture(t), control = await logged(f), independent = await logged(f), worker = await peer(f.port);
  assert.equal((await worker.request('AUTH_ATTACH', { ticket: 'x'.repeat(43), userId: control.identity.userId })).code, 'AUTH_FAILED');
  const ticket = (await control.request('AUTH_WINDOW')).data.ticket;
  const joined = await worker.request('AUTH_ATTACH', { ticket, username: 'bob', userId: randomUUID() });
  assert.equal(joined.data.userId, control.identity.userId);
  const bytes = randomBytes(8193), id = await openResume(worker, bytes);
  await worker.chunk(id, 0, bytes.subarray(0, 8192));
  await control.request('AUTH_LOGOUT'); await worker.closed;
  assert.equal((await independent.request('AUTH_ME')).data.userId, control.identity.userId);
  const status = await independent.request('UPLOAD_STATUS', { uploadId: id }); assert.equal(status.data.received, 8192);
  const newcomer = await peer(f.port); assert.equal((await newcomer.request('AUTH_ATTACH', { ticket })).code, 'AUTH_FAILED');
  assert.equal((await control.request('AUTH_ME')).code, 'AUTH_REQUIRED');
  await independent.request('UPLOAD_FORGET', { uploadId: id });
});

test('upload pause/disconnect/resume verifies ownership, source hash, offset, exclusive claim and lost completion status', async t => {
  const f = await fixture(t), a = await logged(f), other = await logged(f), b = await logged(f, 'bob');
  const bytes = randomBytes(48017), id = await openResume(a, bytes);
  await a.chunk(id, 0, bytes.subarray(0, 8192));
  const args = { uploadId: id, name: 'resume.bin', size: bytes.length, sha256: digest(bytes) };
  assert.equal((await other.request('UPLOAD_RESUME', args)).code, 'UPLOAD_BUSY');
  assert.equal((await b.request('UPLOAD_STATUS', { uploadId: id })).code, 'UPLOAD_NOT_FOUND');
  assert.equal((await b.request('UPLOAD_RESUME', args)).code, 'UPLOAD_NOT_FOUND');
  assert.equal((await b.request('UPLOAD_FORGET', { uploadId: id })).code, 'UPLOAD_NOT_FOUND');
  assert.equal((await a.chunk(id, 1, bytes.subarray(0, 1))).code, 'UPLOAD_OFFSET');
  assert.equal((await a.request('UPLOAD_PAUSE', { uploadId: id })).type, 'UPLOAD_PAUSE_RESULT');
  assert.equal((await other.request('UPLOAD_RESUME', { ...args, sha256: digest(Buffer.from('changed')) })).code, 'UPLOAD_HASH');
  const resumed = await other.request('UPLOAD_RESUME', args); assert.equal(resumed.data.received, 8192);
  await other.chunk(id, 8192, bytes.subarray(8192, 16384)); other.ws.terminate(); await other.closed;
  await until(() => f.uploadStore.active.size === 0);
  assert.equal((await a.request('UPLOAD_RESUME', args)).data.received, 16384);
  await finish(a, id, bytes, 16384);
  const committed = await a.request('UPLOAD_STATUS', { uploadId: id }); assert.equal(committed.data.state, 'committed');
  assert.equal((await a.request('UPLOAD_FORGET', { uploadId: id })).code, 'UPLOAD_ALREADY_COMMITTED');
  assert.equal(digest(readFileSync(f.uploadStore.paths(id).final)), digest(bytes));
});

test('actual process crash and restart recover only durable upload prefix and preserve final integrity', async t => {
  const accounts = temporaryAccounts(), password = randomBytes(24).toString('base64url');
  await createAccount(accounts.store, 'alice', password);
  let child;
  const start = async () => {
    child = fork(new URL('./resume-child.js', import.meta.url), [], { env: { ...process.env, SFT_DATA_DIR: join(accounts.directory, 'data') }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true });
    let err = ''; child.stderr.on('data', data => { err += data; });
    return Promise.race([once(child, 'message').then(([message]) => message.port), once(child, 'exit').then(() => { throw new Error('Child exited: ' + err); })]);
  };
  t.after(async () => { if (child?.connected) { const exited = once(child, 'exit'); child.send('stop'); await exited; } accounts.cleanup(); });
  let port = await start(), p = await peer(port); await p.request('AUTH_LOGIN', { username: 'alice', password });
  const bytes = randomBytes(65539), id = await openResume(p, bytes); await p.chunk(id, 0, bytes.subarray(0, 8192)); await p.chunk(id, 8192, bytes.subarray(8192, 16384));
  const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; await p.closed;
  port = await start(); p = await peer(port); await p.request('AUTH_LOGIN', { username: 'alice', password });
  const reply = await p.request('UPLOAD_RESUME', { uploadId: id, name: 'resume.bin', size: bytes.length, sha256: digest(bytes) });
  assert.equal(reply.data.received, 16384); await finish(p, id, bytes, 16384);
  assert.equal(digest(readFileSync(join(accounts.directory, 'data/uploads/objects', id + '.bin'))), digest(bytes));
});

test('download resumes existing prefix, rejects changed prefix/wrong offset/cross-user and verifies full digest', async t => {
  const f = await fixture(t), a = await logged(f), b = await logged(f, 'bob');
  const bytes = randomBytes(48017), file = await upload(a, bytes), begin = await a.request('DOWNLOAD_BEGIN', { fileId: file.fileId });
  const first = await a.request('DOWNLOAD_CHUNK', { downloadId: begin.data.downloadId, offset: 0 });
  assert.deepEqual(first.data, bytes.subarray(0, 8192)); a.ws.terminate(); await a.closed;
  const next = await logged(f);
  const args = { fileId: file.fileId, size: bytes.length, sha256: digest(bytes), offset: 8192, prefixSha256: digest(first.data) };
  assert.equal((await b.request('DOWNLOAD_OPEN', args)).code, 'FILE_NOT_FOUND');
  assert.equal((await next.request('DOWNLOAD_OPEN', { ...args, offset: bytes.length + 1 })).code, 'DOWNLOAD_OFFSET');
  assert.equal((await next.request('DOWNLOAD_OPEN', { ...args, prefixSha256: '0'.repeat(64) })).code, 'DOWNLOAD_OFFSET');
  await until(() => f.uploadStore.active.size === 0);
  const resumed = await next.request('DOWNLOAD_OPEN', args); assert.equal(resumed.data.offset, 8192);
  const blocks = [first.data];
  for (let at = 8192; at < bytes.length; at += 8192) blocks.push((await next.request('DOWNLOAD_CHUNK', { downloadId: resumed.data.downloadId, offset: at })).data);
  assert.equal((await next.request('DOWNLOAD_COMPLETE', { downloadId: resumed.data.downloadId })).type, 'DOWNLOAD_COMPLETE_RESULT');
  assert.equal(digest(Buffer.concat(blocks)), digest(bytes));
});

test('ordinary/VIP byte rates aggregate across simultaneous connections in both directions, health and other users remain responsive', async t => {
  const f = await fixture(t), a = await logged(f), a2 = await logged(f), vip = await logged(f, 'bob');
  f.accounts.store.db.prepare('INSERT INTO account_policy VALUES (?,?,?,?)').run(a.identity.userId, 'ordinary', 65536, 65536);
  f.accounts.store.db.prepare('INSERT INTO account_policy VALUES (?,?,?,?)').run(vip.identity.userId, 'vip', 262144, 262144);
  const bytes = randomBytes(262144);
  async function measure(label, work, count, rate) {
    const start = performance.now(); const result = await work(); const seconds = (performance.now() - start) / 1000;
    assert.ok(count <= seconds * rate + 8192 + rate * 0.08, `${label} exceeded configured rate/burst`);
    assert.ok(seconds < count / rate * 1.8 + 1, `${label} excessively slow`);
    t.diagnostic(JSON.stringify({ label, bytes: count, seconds, bytesPerSecond: count / seconds, configured: rate, burstBytes: 8192, toleranceSeconds: 0.08 })); return result;
  }
  const solo = await measure('ordinary-upload-single', () => upload(a, bytes), bytes.length, 65536);
  const pair = measure('ordinary-upload-two-connections', () => Promise.all([upload(a, bytes.subarray(0, 131072)), upload(a2, bytes.subarray(131072))]), bytes.length, 65536);
  const other = measure('vip-upload-concurrent', () => upload(vip, bytes), bytes.length, 262144);
  const start = performance.now(); assert.equal(await health(f.port), 200); assert.equal((await vip.request('AUTH_ME')).type, 'AUTH_ME_RESULT'); assert.ok(performance.now() - start < 1000);
  await Promise.all([pair, other]);
  async function download(p) {
    const begin = await p.request('DOWNLOAD_BEGIN', { fileId: solo.fileId }), id = begin.data.downloadId;
    for (let at = 0; at < bytes.length; at += 8192) assert.equal((await p.request('DOWNLOAD_CHUNK', { downloadId: id, offset: at })).data.length, 8192);
    assert.equal((await p.request('DOWNLOAD_COMPLETE', { downloadId: id })).type, 'DOWNLOAD_COMPLETE_RESULT');
  }
  await measure('ordinary-download-two-connections', () => Promise.all([download(a), download(a2)]), bytes.length * 2, 65536);
});

function clientCertificate(directory, caPath, caKey, name, eku = 'clientAuth', days = '2') {
  const key = join(directory, name + '.key'), csr = join(directory, name + '.csr'), cert = join(directory, name + '.crt'), ext = join(directory, name + '.cnf');
  const run = (...args) => execFileSync('openssl', args, { windowsHide: true, stdio: 'pipe' });
  run('genpkey', '-algorithm', 'RSA', '-pkeyopt', 'rsa_keygen_bits:2048', '-out', key);
  run('req', '-new', '-key', key, '-out', csr, '-subj', '/CN=not-an-account-name');
  writeFileSync(ext, `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=${eku}\n`);
  const validity = days === '-1' ? ['-not_before', '20200101000000Z', '-not_after', '20200102000000Z'] : ['-days', days];
  run('x509', '-req', '-in', csr, '-CA', caPath, '-CAkey', caKey, '-set_serial', '0x' + randomBytes(16).toString('hex'), ...validity, '-out', cert, '-extfile', ext);
  return { cert: readFileSync(cert), key: readFileSync(key), x509: new X509Certificate(readFileSync(cert)) };
}
test('mTLS requires trusted valid clientAuth and administrator binding; rejects absent/wrong CA/expired/wrong EKU/unbound/disabled/impersonation', async t => {
  const f = await fixture(t, { tlsOptions: loadTlsOptions(defaultCertDirectory, 'mtls-required'), authOptions: { mode: 'mtls-required' } });
  const caPath = join(defaultCertDirectory, 'public/dev-ca.crt'), caKey = join(defaultCertDirectory, 'private/ca.key');
  const alice = clientCertificate(f.accounts.directory, caPath, caKey, 'alice'), unbound = clientCertificate(f.accounts.directory, caPath, caKey, 'unbound');
  const expired = clientCertificate(f.accounts.directory, caPath, caKey, 'expired', 'clientAuth', '-1');
  const wrongEku = clientCertificate(f.accounts.directory, caPath, caKey, 'eku', 'serverAuth');
  const fingerprint = alice.x509.fingerprint256.replaceAll(':', '').toLowerCase(), user = f.accounts.store.findByUsername('alice');
  f.accounts.store.db.prepare('INSERT INTO client_certificates VALUES (?,?,0,?,?)').run(fingerprint, user.user_id, new Date(alice.x509.validTo).toISOString(), new Date().toISOString());
  for (const options of [{}, expired, wrongEku, { cert: alice.cert, key: alice.key, ca: Buffer.from('invalid') }]) {
    await assert.rejects(peer(f.port, options));
  }
  // Self-signed client certificate is a different CA even though the server CA stays trusted.
  const rogueKey = join(f.accounts.directory, 'rogue.key'), rogueCert = join(f.accounts.directory, 'rogue.crt');
  execFileSync('openssl', ['req', '-new', '-x509', '-newkey', 'rsa:2048', '-noenc', '-keyout', rogueKey, '-out', rogueCert, '-days', '1', '-subj', '/CN=rogue', '-addext', 'extendedKeyUsage=clientAuth'], { stdio: 'pipe', windowsHide: true });
  await assert.rejects(peer(f.port, { cert: readFileSync(rogueCert), key: readFileSync(rogueKey) }));
  const unknown = await peer(f.port, unbound); assert.equal((await unknown.request('AUTH_CERT')).code, 'AUTH_FAILED');
  const p = await peer(f.port, alice);
  assert.equal((await p.request('AUTH_LOGIN', { username: 'alice', password: f.password })).code, 'AUTH_FAILED');
  assert.equal((await p.request('AUTH_CERT', { username: 'bob' })).code, 'AUTH_FAILED');
  assert.equal((await p.request('AUTH_CERT')).data.userId, user.user_id);
  await p.request('AUTH_LOGOUT'); assert.equal((await p.request('AUTH_ME')).code, 'AUTH_REQUIRED');
  assert.equal((await p.request('AUTH_CERT')).data.userId, user.user_id);
  f.accounts.store.db.prepare('UPDATE client_certificates SET disabled=1 WHERE fingerprint=?').run(fingerprint);
  await until(() => p.events.some(event => event.type === 'AUTH_EXPIRED'), 2000);
  assert.equal((await p.request('AUTH_ME')).code, 'AUTH_REQUIRED');
  const disabled = await peer(f.port, alice); assert.equal((await disabled.request('AUTH_CERT')).code, 'AUTH_FAILED');
});

test('resumable pre-commit disconnect rolls back only its unpublished link and resumes without service restart', async t => {
  let release, reached;
  const arrived = new Promise(resolve => { reached = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  let interrupted = false;
  const f = await fixture(t, { uploadOptions: { hooks: { beforeCommit: async () => {
    if (!interrupted) { interrupted = true; reached(); await gate; }
  } } } });
  const p = await logged(f), bytes = randomBytes(8192), id = await openResume(p, bytes);
  await p.chunk(id, 0, bytes); const complete = p.request('UPLOAD_COMPLETE', { uploadId: id, sha256: digest(bytes) }).catch(() => {});
  await arrived; p.ws.terminate(); await p.closed; release();
  await until(() => f.uploadStore.active.size === 0);
  const next = await logged(f);
  const reply = await next.request('UPLOAD_RESUME', { uploadId: id, name: 'resume.bin', size: bytes.length, sha256: digest(bytes) });
  assert.equal(reply.data.received, bytes.length); await finish(next, id, bytes, bytes.length);
  assert.equal(digest(readFileSync(f.uploadStore.paths(id).final)), digest(bytes));
  // Consume the intentionally lost reply's bounded test timeout; it is not a production retry.
  await complete;
});

test('paused retention releases slots but reserves quota; expiry and explicit cancellation clean owned objects', async t => {
  const f = await fixture(t, { uploadOptions: { policy: { retentionMs: 120, quotaBytes: 8192 } } }), p = await logged(f);
  const bytes = randomBytes(8192), id = await openResume(p, bytes); await p.chunk(id, 0, bytes);
  await p.request('UPLOAD_PAUSE', { uploadId: id }); assert.equal(f.uploadStore.active.size, 0); assert.equal(f.uploadStore.used, 8192);
  assert.equal((await p.request('UPLOAD_OPEN', { name: 'other', size: 1, sha256: digest(Buffer.from('x')) })).code, 'UPLOAD_QUOTA');
  await delay(150); assert.equal((await p.request('UPLOAD_STATUS', { uploadId: id })).code, 'UPLOAD_EXPIRED');
  f.uploadStore.sweep(); assert.equal(f.uploadStore.used, 0); assert.equal(f.uploadStore.find.get(id), undefined);
  const id2 = await openResume(p, bytes); await p.chunk(id2, 0, bytes);
  await p.request('UPLOAD_CANCEL', { uploadId: id2 }); assert.equal(f.uploadStore.used, 0); assert.equal(f.uploadStore.find.get(id2), undefined);
});
