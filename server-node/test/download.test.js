import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile, unlink, truncate, open, stat } from 'node:fs/promises';
import { get } from 'node:https';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { fixture, peer, logged, upload, until, delay, ca, digest } from './upload-fixture.js';
import { encodeDownloadChunk, decodeDownloadChunk } from '../src/download-protocol.js';
import { createService } from '../src/service.js';
import { temporaryAccounts } from './helpers.js';

async function begin(p, fileId) {
  const r = await p.request('DOWNLOAD_BEGIN', { fileId }); assert.equal(r.type, 'DOWNLOAD_BEGIN_RESULT'); return r.data;
}
async function download(p, fileId) {
  const info = await begin(p, fileId), blocks = []; let offset = 0;
  while (offset < info.size) {
    const r = await p.request('DOWNLOAD_CHUNK', { downloadId: info.downloadId, offset });
    assert.equal(r.type, 'DOWNLOAD_CHUNK_RESULT'); assert.equal(r.downloadId, info.downloadId); assert.equal(r.offset, offset);
    assert.equal(r.data.length, Math.min(8192, info.size - offset)); blocks.push(r.data); offset += r.data.length;
  }
  const final = await p.request('DOWNLOAD_COMPLETE', { downloadId: info.downloadId });
  assert.equal(final.type, 'DOWNLOAD_COMPLETE_RESULT');
  const bytes = Buffer.concat(blocks); assert.equal(digest(bytes), info.sha256); return bytes;
}

test('SFTD header vector, strict bytes, and preserved SFTU distinction', () => {
  const requestId = '00112233-4455-4677-8899-aabbccddeeff', downloadId = 'ffeeddcc-bbaa-4988-8776-554433221100';
  const frame = encodeDownloadChunk(requestId, downloadId, 0x01020304, Buffer.from([0xa5]));
  assert.equal(frame.subarray(0, 8).toString('hex'), '5346544401020000');
  assert.equal(frame.subarray(80).toString('hex'), '000000000102030400000001a5');
  assert.deepEqual(decodeDownloadChunk(frame), { requestId, downloadId, offset: 0x01020304, data: Buffer.from([0xa5]) });
  for (const position of [0, 4, 5, 6, 8, 88]) { const bad = Buffer.from(frame); bad[position] = 255; assert.throws(() => decodeDownloadChunk(bad)); }
});

test('upload/list/download boundaries, Chinese duplicate names, short reads and reusable connection', async t => {
  const f = await fixture(t, { uploadOptions: { hooks: { maxReadBytes: 1031 } } }), p = await logged(f), ids = new Set();
  for (const size of [0, 1, 8191, 8192, 8193, 48017]) {
    const source = randomBytes(size), file = await upload(p, source, '同名中文.bin'); ids.add(file.fileId);
    const page = await p.request('FILES_LIST'); assert.ok(page.data.files.some(x => x.fileId === file.fileId));
    const received = await download(p, file.fileId), stored = await readFile(f.uploadStore.paths(file.fileId).final);
    assert.equal(received.length, size); assert.equal(stored.length, size); assert.equal(digest(received), digest(source)); assert.equal(digest(stored), digest(source));
    assert.equal((await p.request('AUTH_ME')).data.userId, p.identity.userId);
    await delay(210); // Stay within the documented list token bucket.
  }
  assert.equal(ids.size, 6); assert.equal(f.uploadStore.active.size, 0);
});

test('bounded signed keyset pagination and owner isolation; no paths or foreign metadata', async t => {
  const f = await fixture(t), a = await logged(f), b = await logged(f, 'bob'), anonymous = await peer(f.port);
  for (let i = 0; i < 23; i++) await upload(a, Buffer.alloc(0), '中'.repeat(78) + '.x');
  const bob = await upload(b, Buffer.from('b'));
  for (const type of ['FILES_LIST', 'DOWNLOAD_BEGIN', 'DOWNLOAD_CHUNK', 'DOWNLOAD_COMPLETE'])
    assert.equal((await anonymous.request(type, {})).code, 'AUTH_REQUIRED');
  const first = await a.request('FILES_LIST', { limit: 20, ownerId: b.identity.userId });
  assert.equal(first.data.files.length, 20); assert.ok(Buffer.byteLength(JSON.stringify(first)) <= 16384);
  assert.ok(first.data.files.every(x => Object.keys(x).sort().join() === 'committedAt,fileId,name,sha256,size'));
  const second = await a.request('FILES_LIST', { limit: 20, cursor: first.data.nextCursor });
  assert.equal(second.data.files.length, 3); assert.equal(second.data.nextCursor, null);
  assert.equal(new Set([...first.data.files, ...second.data.files].map(x => x.fileId)).size, 23);
  assert.deepEqual((await b.request('FILES_LIST')).data.files.map(x => x.fileId), [bob.fileId]);
  assert.equal((await b.request('FILES_LIST', { cursor: first.data.nextCursor })).code, 'INVALID_CURSOR');
  assert.equal((await a.request('FILES_LIST', { cursor: "' OR 1=1 --" })).code, 'INVALID_CURSOR');
  assert.equal((await a.request('FILES_LIST', { limit: 21 })).code, 'INVALID_MESSAGE');
  const forbidden = await b.request('DOWNLOAD_BEGIN', { fileId: first.data.files[0].fileId, userId: a.identity.userId });
  const missing = await b.request('DOWNLOAD_BEGIN', { fileId: randomUUID() });
  assert.equal(forbidden.code, 'FILE_NOT_FOUND'); assert.equal(forbidden.code, missing.code); assert.equal(forbidden.message, missing.message);
  assert.equal((await b.request('DOWNLOAD_BEGIN', { fileId: "' OR 1=1 --" })).code, 'INVALID_MESSAGE');
  const burst = await Promise.all(Array.from({ length: 12 }, () => a.request('FILES_LIST')));
  assert.ok(burst.some(x => x.code === 'FILE_RATE_LIMITED'));
});

test('download IDs bind connection, strict offsets/types, upload/download exclusion and shared four slots', async t => {
  const f = await fixture(t, { uploadOptions: { policy: { maxActive: 4 } } }), a = await logged(f), b = await logged(f, 'bob'), same = await logged(f);
  const file = await upload(a, randomBytes(8193)), info = await begin(a, file.fileId);
  for (const p of [b, same]) for (const type of ['DOWNLOAD_CHUNK', 'DOWNLOAD_COMPLETE', 'DOWNLOAD_CANCEL'])
    assert.equal((await p.request(type, { downloadId: info.downloadId, offset: 0 })).code, 'DOWNLOAD_NOT_FOUND');
  assert.equal((await a.request('DOWNLOAD_CHUNK', { downloadId: randomUUID(), offset: 0 })).code, 'DOWNLOAD_NOT_FOUND');
  for (const offset of [-1, '0', null, 0.1]) assert.equal((await a.request('DOWNLOAD_CHUNK', { downloadId: info.downloadId, offset })).code, 'INVALID_MESSAGE');
  assert.equal((await a.request('DOWNLOAD_CHUNK', { downloadId: [info.downloadId], offset: 0 })).code, 'INVALID_MESSAGE');
  assert.equal((await a.request('DOWNLOAD_CHUNK', { downloadId: info.downloadId, offset: 1 })).code, 'DOWNLOAD_OFFSET');
  assert.equal((await a.request('UPLOAD_BEGIN', { name: 'busy', size: 0 })).code, 'TRANSFER_BUSY');
  await a.request('DOWNLOAD_CHUNK', { downloadId: info.downloadId, offset: 0 });
  assert.equal((await a.request('DOWNLOAD_CHUNK', { downloadId: info.downloadId, offset: 0 })).code, 'DOWNLOAD_OFFSET');
  const ownAgain = await begin(same, file.fileId); assert.notEqual(ownAgain.downloadId, info.downloadId);
  const c = await logged(f), d = await logged(f);
  await b.request('UPLOAD_BEGIN', { name: 'reserved', size: 1 }); await c.request('UPLOAD_BEGIN', { name: 'reserved', size: 1 });
  assert.equal(f.uploadStore.active.size, 4);
  assert.equal((await d.request('DOWNLOAD_BEGIN', { fileId: file.fileId })).code, 'TRANSFER_LIMIT');
  assert.equal((await d.request('UPLOAD_BEGIN', { name: 'reserved', size: 1 })).code, 'UPLOAD_LIMIT');
  assert.equal((await c.request('DOWNLOAD_BEGIN', { fileId: file.fileId })).code, 'TRANSFER_BUSY');
  await a.request('DOWNLOAD_CANCEL'); await same.request('DOWNLOAD_CANCEL'); await b.request('UPLOAD_CANCEL'); await c.request('UPLOAD_CANCEL');
  assert.equal(f.uploadStore.active.size, 0); assert.equal((await a.request('AUTH_ME')).data.userId, a.identity.userId);
});

test('missing/truncated/corrupted committed sources never complete and are never deleted by downloads', async t => {
  const f = await fixture(t), p = await logged(f);
  for (const mode of ['missing', 'truncated', 'corrupt', 'truncatedAfterBegin']) {
    const bytes = randomBytes(8193), file = await upload(p, bytes), path = f.uploadStore.paths(file.fileId).final;
    let info;
    if (mode === 'truncatedAfterBegin') info = await begin(p, file.fileId);
    if (mode === 'missing') await unlink(path);
    else if (mode.startsWith('truncated')) await truncate(path, 1);
    else { bytes[0] ^= 255; await writeFile(path, bytes); }
    if (mode === 'missing' || mode === 'truncated') assert.equal((await p.request('DOWNLOAD_BEGIN', { fileId: file.fileId })).code, 'FILE_UNAVAILABLE');
    else {
      info ??= await begin(p, file.fileId);
      if (mode === 'truncatedAfterBegin') assert.equal((await p.request('DOWNLOAD_CHUNK', { downloadId: info.downloadId, offset: 0 })).code, 'FILE_UNAVAILABLE');
      else {
        await p.request('DOWNLOAD_CHUNK', { downloadId: info.downloadId, offset: 0 });
        await p.request('DOWNLOAD_CHUNK', { downloadId: info.downloadId, offset: 8192 });
        assert.equal((await p.request('DOWNLOAD_COMPLETE', { downloadId: info.downloadId })).code, 'FILE_UNAVAILABLE');
      }
    }
    await until(() => f.uploadStore.active.size === 0);
    assert.equal(f.uploadStore.find.get(file.fileId).state, 'committed');
    if (mode !== 'missing') assert.ok((await stat(path)).isFile());
  }
});

test('cancel/logout/expiry/disconnect/stop during read suppress late binary and release handles', async t => {
  for (const action of ['cancel', 'logout', 'expiry', 'disconnect', 'stop']) {
    let release;
    const f = await fixture(t, { authOptions: action === 'expiry' ? { sessionMs: 300 } : {},
      uploadOptions: { hooks: { beforeRead: () => new Promise(resolve => { release = resolve; }) } } });
    const p = await logged(f), file = await upload(p, randomBytes(8193)), info = await begin(p, file.fileId);
    p.ws.send(JSON.stringify({ version: 1, type: 'DOWNLOAD_CHUNK', requestId: randomUUID(), data: { downloadId: info.downloadId, offset: 0 } }));
    await until(() => Boolean(release)); let ending;
    if (action === 'cancel') ending = p.request('DOWNLOAD_CANCEL');
    if (action === 'logout') await p.request('AUTH_LOGOUT');
    if (action === 'expiry') await until(() => p.events.some(x => x.type === 'AUTH_EXPIRED'));
    if (action === 'disconnect') { p.ws.terminate(); await p.closed; }
    if (action === 'stop') ending = f.stop();
    await delay(30); release(); await ending; await until(() => f.uploadStore.active.size === 0);
    assert.ok(!p.replies.some(x => x.type === 'DOWNLOAD_CHUNK_RESULT'));
    const handle = await open(f.uploadStore.paths(file.fileId).final, 'r+'); await handle.close();
    if (action === 'cancel') assert.equal((await p.request('AUTH_ME')).data.userId, p.identity.userId);
    if (action === 'stop') {
      const listener = createServer(); listener.listen(f.port, '127.0.0.1'); await once(listener, 'listening'); await new Promise(resolve => listener.close(resolve));
    }
  }
});

test('download idle/absolute deadlines ignore heartbeat; pipelining is closed without unbounded work', async t => {
  for (const policy of [{ idleMs: 120 }, { idleMs: 5000, totalMs: 120 }]) {
    const f = await fixture(t, { uploadOptions: { policy }, heartbeatIntervalMs: 20 }), p = await logged(f);
    const file = await upload(p, Buffer.from('a')); await begin(p, file.fileId);
    await p.request('ECHO', { text: 'does not refresh deadline' });
    await until(() => p.events.some(x => x.type === 'DOWNLOAD_ABORTED')); await until(() => f.uploadStore.active.size === 0);
    assert.equal((await p.request('AUTH_ME')).data.userId, p.identity.userId);
  }
  let reads = 0;
  const f = await fixture(t, { uploadOptions: { hooks: { beforeRead: async () => { reads++; await delay(100); } } } }), p = await logged(f);
  const file = await upload(p, randomBytes(8193)), info = await begin(p, file.fileId);
  for (let i = 0; i < 100; i++) p.ws.send(JSON.stringify({ version: 1, type: 'DOWNLOAD_CHUNK', requestId: randomUUID(), data: { downloadId: info.downloadId, offset: 0 } }));
  assert.equal(await p.closed, 1008); await until(() => f.uploadStore.active.size === 0); assert.equal(reads, 1);
});

test('Alice uploads while Bob downloads; health, heartbeat, identity and later uploads remain usable', async t => {
  const f = await fixture(t, { heartbeatIntervalMs: 20, uploadOptions: { hooks: { beforeRead: () => delay(40), beforeWrite: () => delay(40) } } });
  const a = await logged(f), b = await logged(f, 'bob'), data = randomBytes(65536), file = await upload(b, data);
  let pings = 0; b.ws.on('ping', () => pings++);
  const jobs = Promise.all([upload(a, data), download(b, file.fileId)]); await until(() => f.uploadStore.active.size === 2);
  const start = performance.now();
  await new Promise((resolve, reject) => get(`https://127.0.0.1:${f.port}/health`, { ca }, response => { assert.equal(response.statusCode, 200); response.resume(); response.on('end', resolve); }).on('error', reject));
  assert.ok(performance.now() - start < 1000);
  assert.equal((await b.request('AUTH_ME')).data.userId, b.identity.userId);
  await jobs; assert.ok(pings > 0); assert.equal(f.uploadStore.active.size, 0); await upload(b, Buffer.alloc(0));
});

test('occupied random port rejects a second service without disturbing its owner', async t => {
  const original = await fixture(t), p = await logged(original), accounts = temporaryAccounts();
  const contender = createService({ accountStore: accounts.store });
  try {
    const failed = once(contender.server, 'error'); contender.server.listen(original.port, '127.0.0.1');
    assert.equal((await failed)[0].code, 'EADDRINUSE'); await contender.stop();
    assert.equal((await p.request('AUTH_ME')).data.userId, p.identity.userId);
    assert.equal((await p.request('ECHO', { text: 'original service still running' })).type, 'ECHO_RESULT');
  } finally { await contender.stop(); accounts.cleanup(); }
});
