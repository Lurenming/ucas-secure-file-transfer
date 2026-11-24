import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, stat, readdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { get } from 'node:https';
import { join } from 'node:path';
import { UploadStore } from '../src/upload-store.js';
import { encodeChunk, decodeChunk, validDisplayName, validUploadId } from '../src/upload-protocol.js';
import { temporaryAccounts } from './helpers.js';
import { fixture, peer, logged, upload, until, delay, ca, digest } from './upload-fixture.js';

test('binary header is canonical ASCII UUID + big endian integers; filename rules', () => {
  const requestId = '00112233-4455-4677-8899-aabbccddeeff', uploadId = 'ffeeddcc-bbaa-4988-8776-554433221100';
  const frame = encodeChunk(requestId, uploadId, 0x01020304, Buffer.from([0xa5]));
  assert.equal(frame.length, 93); assert.equal(frame.subarray(0, 8).toString('hex'), '5346545501010000');
  assert.equal(frame.subarray(80, 92).toString('hex'), '000000000102030400000001');
  assert.deepEqual(decodeChunk(frame), { requestId, uploadId, offset: 0x01020304, data: Buffer.from([0xa5]) });
  for (const bad of ['', '..', 'a/b', 'a\\b', 'a:b', 'C:\\x', 'a\0b', 'a\nb', 'CON.txt', 'LPT1', 'x.', 'x ', 'a'.repeat(121)]) assert.equal(validDisplayName(bad), false);
  assert.ok(validDisplayName('课程实验报告.txt'));
  for (const name of ['CONIN$', 'CONOUT$.txt', 'con .txt']) assert.equal(validDisplayName(name), false);
  for (const id of [[uploadId], { id: uploadId }, null, 1]) assert.equal(validUploadId(id), false);
});

test('zero/one/8191/8192/8193/multiblock, short writes, Chinese names and same-name isolation', async t => {
  const f = await fixture(t, { uploadOptions: { hooks: { maxWriteBytes: 1031 } } });
  const p = await logged(f), ids = new Set();
  for (const size of [0, 1, 8191, 8192, 8193, 48017]) {
    const bytes = randomBytes(size), result = await upload(p, bytes, '同名中文.txt'); ids.add(result.fileId);
    const saved = f.uploadStore.paths(result.fileId).final;
    assert.equal((await stat(saved)).size, size);
    assert.equal(digest(await readFile(saved)), digest(bytes));
    const row = f.uploadStore.find.get(result.fileId);
    assert.equal(row.state, 'committed'); assert.equal(row.owner_id, p.identity.userId); assert.equal(row.sha256, digest(bytes));
    assert.equal((await p.request('AUTH_ME')).data.userId, p.identity.userId);
  }
  assert.equal(ids.size, 6); assert.equal(f.uploadStore.active.size, 0);
  assert.ok((await readdir(f.uploadStore.objects)).every(name => name.endsWith('.bin')));
});

test('authentication/owner/id, order, declared lengths, hash, malformed binary and size limits', async t => {
  const f = await fixture(t), anonymous = await peer(f.port);
  assert.equal((await anonymous.request('UPLOAD_BEGIN', { name: 'x', size: 1 })).code, 'AUTH_REQUIRED');
  assert.equal((await anonymous.chunk(randomUUID(), 0, Buffer.from('x'))).code, 'AUTH_REQUIRED');
  const a = await logged(f), b = await logged(f, 'bob'), sameUser = await logged(f);
  for (const size of [-1, 100 * 1024 * 1024 + 1, 1.5, '1']) assert.equal((await a.request('UPLOAD_BEGIN', { name: 'x', size })).code, 'UPLOAD_SIZE');
  assert.equal((await a.request('UPLOAD_BEGIN', { name: '../escape', size: 1 })).code, 'INVALID_MESSAGE');
  const begin = await a.request('UPLOAD_BEGIN', { name: 'x', size: 2, userId: b.identity.userId });
  const id = begin.data.uploadId;
  assert.equal(f.uploadStore.find.get(id).owner_id, a.identity.userId);
  for (const other of [b, sameUser]) {
    assert.equal((await other.chunk(id, 0, Buffer.from('x'))).code, 'UPLOAD_NOT_FOUND');
    assert.equal((await other.request('UPLOAD_COMPLETE', { uploadId: id, sha256: digest('xx') })).code, 'UPLOAD_NOT_FOUND');
    assert.equal((await other.request('UPLOAD_CANCEL', { uploadId: id })).code, 'UPLOAD_NOT_FOUND');
  }
  assert.equal((await a.chunk(randomUUID(), 0, Buffer.from('x'))).code, 'UPLOAD_NOT_FOUND');
  assert.equal((await a.chunk(id, 1, Buffer.from('x'))).code, 'UPLOAD_OFFSET');
  assert.equal((await a.chunk(id, 0, Buffer.from('xxx'))).code, 'UPLOAD_SIZE');
  assert.equal((await a.chunk(id, 0, Buffer.from('x'))).type, 'UPLOAD_CHUNK_RESULT');
  assert.equal((await a.chunk(id, 0, Buffer.from('x'))).code, 'UPLOAD_OFFSET');
  assert.equal((await a.request('UPLOAD_COMPLETE', { uploadId: id, sha256: digest('x') })).code, 'UPLOAD_SIZE');
  await until(() => f.uploadStore.active.size === 0);
  const badHash = (await a.request('UPLOAD_BEGIN', { name: 'hash', size: 0 })).data.uploadId;
  assert.equal((await a.request('UPLOAD_COMPLETE', { uploadId: badHash, sha256: '0'.repeat(64) })).code, 'UPLOAD_HASH');
  await until(() => f.uploadStore.active.size === 0);
  for (const mutate of [x => x.subarray(0, 91), x => { x[0] = 0; return x; }, x => { x[6] = 1; return x; },
    x => { x[8] = 0xe1; return x; }, x => { x.writeUInt32BE(2, 88); return x; }, x => { x.writeBigUInt64BE(2n ** 63n, 80); return x; }]) {
    const p = await peer(f.port); p.ws.send(mutate(encodeChunk(randomUUID(), randomUUID(), 0, Buffer.from('x'))));
    assert.equal(await p.closed, 1003);
  }
});

test('cancel/disconnect/logout/expiry and idle timeout clean pending uploads without reviving writes', async t => {
  let release;
  const f = await fixture(t, { uploadOptions: { hooks: { beforeWrite: () => new Promise(resolve => { release = resolve; }) } } });
  const p = await logged(f), id = (await p.request('UPLOAD_BEGIN', { name: 'pending', size: 1 })).data.uploadId;
  const ack = p.chunk(id, 0, Buffer.from('x'));
  await until(() => Boolean(release));
  const cancel = p.request('UPLOAD_CANCEL', { uploadId: id }); await delay(30); release();
  assert.equal((await ack).code, 'UPLOAD_CANCELLED'); assert.equal((await cancel).type, 'UPLOAD_CANCEL_RESULT');
  assert.equal((await p.request('AUTH_ME')).data.userId, p.identity.userId);
  await upload(p, Buffer.alloc(0));
  const logoutId = (await p.request('UPLOAD_BEGIN', { name: 'logout', size: 1 })).data.uploadId;
  await p.request('AUTH_LOGOUT'); await until(() => !f.uploadStore.find.get(logoutId));
  const b = await logged(f), disconnectId = (await b.request('UPLOAD_BEGIN', { name: 'disconnect', size: 1 })).data.uploadId;
  b.ws.terminate(); await b.closed; await until(() => !f.uploadStore.find.get(disconnectId));
  const expiry = await fixture(t, { authOptions: { sessionMs: 150 }, uploadOptions: { policy: { idleMs: 5000 } } });
  const e = await logged(expiry), expiredId = (await e.request('UPLOAD_BEGIN', { name: 'expiry', size: 1 })).data.uploadId;
  await until(() => e.events.some(x => x.type === 'AUTH_EXPIRED')); await until(() => !expiry.uploadStore.find.get(expiredId));
  const idle = await fixture(t, { uploadOptions: { policy: { idleMs: 100 } }, heartbeatIntervalMs: 20 });
  const i = await logged(idle), idleId = (await i.request('UPLOAD_BEGIN', { name: 'idle', size: 1 })).data.uploadId;
  await i.request('ECHO', { text: 'no upload progress' }); await until(() => !idle.uploadStore.find.get(idleId));
  assert.equal((await i.request('AUTH_ME')).data.userId, i.identity.userId);
});

test('four upload reservations, aggregate quota and bounded admission; parallel users stay responsive', async t => {
  const f = await fixture(t, { uploadOptions: { policy: { quotaBytes: 20, maxActive: 4 } } });
  const peers = await Promise.all(Array.from({ length: 5 }, (_, i) => logged(f, i % 2 ? 'bob' : 'alice')));
  for (let i = 0; i < 4; i++) assert.equal((await peers[i].request('UPLOAD_BEGIN', { name: 'q', size: 5 })).type, 'UPLOAD_BEGIN_RESULT');
  assert.equal((await peers[4].request('UPLOAD_BEGIN', { name: 'q', size: 0 })).code, 'UPLOAD_LIMIT');
  assert.equal(f.uploadStore.used, 20); await peers[0].request('UPLOAD_CANCEL');
  assert.equal((await peers[4].request('UPLOAD_BEGIN', { name: 'q', size: 6 })).code, 'UPLOAD_QUOTA');
  for (const p of peers) await p.request('UPLOAD_CANCEL');
  const [a, b] = await Promise.all([upload(peers[0], Buffer.from('1234567890')), upload(peers[1], Buffer.from('abcdefghij'))]);
  assert.notEqual(a.fileId, b.fileId);
  assert.equal((await peers[2].request('UPLOAD_BEGIN', { name: 'q', size: 1 })).code, 'UPLOAD_QUOTA');
  const concurrent = await fixture(t, { uploadOptions: { hooks: { beforeWrite: () => delay(40) } }, heartbeatIntervalMs: 20 });
  const [x, y] = await Promise.all([logged(concurrent), logged(concurrent, 'bob')]);
  let pings = 0; x.ws.on('ping', () => pings++);
  const jobs = Promise.all([upload(x, randomBytes(65536)), upload(y, randomBytes(65536))]);
  await until(() => concurrent.uploadStore.active.size === 2);
  const began = performance.now();
  await new Promise((resolve, reject) => get(`https://127.0.0.1:${concurrent.port}/health`, { ca }, response => { response.resume(); response.on('end', resolve); }).on('error', reject));
  assert.ok(performance.now() - began < 1000); await jobs; assert.ok(pings > 0);
});

test('logout and session expiry during an outstanding write cannot commit late data', async t => {
  for (const expire of [false, true]) {
    let release;
    const f = await fixture(t, { authOptions: expire ? { sessionMs: 150 } : {},
      uploadOptions: { hooks: { beforeWrite: () => new Promise(resolve => { release = resolve; }) } } });
    const p = await logged(f), id = (await p.request('UPLOAD_BEGIN', { name: 'late', size: 1 })).data.uploadId;
    const writing = p.chunk(id, 0, Buffer.from('x'));
    await until(() => Boolean(release));
    if (expire) await until(() => p.events.some(x => x.type === 'AUTH_EXPIRED'));
    else await p.request('AUTH_LOGOUT');
    release();
    assert.ok(['UPLOAD_CANCELLED', 'AUTH_REQUIRED'].includes((await writing).code));
    await until(() => f.uploadStore.active.size === 0);
    assert.equal(f.uploadStore.find.get(id), undefined);
    assert.equal((await p.request('AUTH_ME')).code, 'AUTH_REQUIRED');
    assert.deepEqual(await readdir(f.uploadStore.objects), []);
  }
});

test('clients that send without ACK cannot build a Promise/disk queue', async t => {
  const f = await fixture(t, { uploadOptions: { hooks: { beforeWrite: () => delay(100) } } });
  const p = await logged(f), id = (await p.request('UPLOAD_BEGIN', { name: 'flood', size: 500 })).data.uploadId;
  for (let i = 0; i < 100; i++) p.ws.send(encodeChunk(randomUUID(), id, i, Buffer.from('x')));
  assert.equal(await p.closed, 1008); await until(() => f.uploadStore.active.size === 0);
  assert.equal(f.uploadStore.count, 0);
});

test('write/database failure discards uncommitted files; cancellation before commit wins', async t => {
  const disk = await fixture(t, { uploadOptions: { hooks: { beforeWrite: () => { throw new Error('simulated disk error'); } } } });
  const p = await logged(disk), id = (await p.request('UPLOAD_BEGIN', { name: 'disk', size: 1 })).data.uploadId;
  assert.equal((await p.chunk(id, 0, Buffer.from('x'))).code, 'UPLOAD_STORAGE_ERROR');
  await until(() => disk.uploadStore.active.size === 0); assert.deepEqual(await readdir(disk.uploadStore.objects), []);
  const database = await fixture(t);
  database.uploadStore.db.exec("CREATE TRIGGER fail_commit BEFORE UPDATE OF state ON files WHEN NEW.state = 'committed' BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
  const q = await logged(database), dbId = (await q.request('UPLOAD_BEGIN', { name: 'db', size: 0 })).data.uploadId;
  assert.equal((await q.request('UPLOAD_COMPLETE', { uploadId: dbId, sha256: digest('') })).code, 'UPLOAD_STORAGE_ERROR');
  await until(() => database.uploadStore.active.size === 0); assert.deepEqual(await readdir(database.uploadStore.objects), []);
  let release;
  const race = await fixture(t, { uploadOptions: { hooks: { beforeCommit: () => new Promise(resolve => { release = resolve; }) } } });
  const r = await logged(race), raceId = (await r.request('UPLOAD_BEGIN', { name: 'race', size: 0 })).data.uploadId;
  const finish = r.request('UPLOAD_COMPLETE', { uploadId: raceId, sha256: digest('') });
  await until(() => Boolean(release)); const cancel = r.request('UPLOAD_CANCEL'); await delay(20); release();
  assert.equal((await finish).code, 'UPLOAD_CANCELLED'); await cancel;
  assert.equal(race.uploadStore.find.get(raceId), undefined); assert.deepEqual(await readdir(race.uploadStore.objects), []);
});

test('process interruption recovery discards only recorded incomplete files and preserves committed data', async () => {
  const accounts = temporaryAccounts();
  try {
    for (const phase of ['receiving', 'preparing', 'published', 'committed']) {
      const directory = join(accounts.directory, 'crash-' + phase);
      const child = spawn(process.execPath, ['test/upload-crash-child.js', directory, phase], { windowsHide: true, stdio: 'pipe' });
      let output = ''; child.stdout.on('data', bytes => { output += bytes; }); child.stderr.resume();
      const [code] = await once(child, 'exit'); assert.equal(code, 72);
      const id = output.trim(); assert.match(id, /^[a-f0-9-]{36}$/);
      const unrelated = join(directory, 'objects', 'unrelated.keep'); await writeFile(unrelated, 'leave alone');
      const recovered = new UploadStore(directory);
      try {
        assert.equal(await readFile(unrelated, 'utf8'), 'leave alone');
        if (phase === 'committed') {
          const row = recovered.find.get(id); assert.equal(row.state, 'committed');
          assert.equal(digest(await readFile(recovered.paths(id).final)), digest('crash-content'));
          assert.equal(recovered.used, Buffer.byteLength('crash-content'));
        } else { assert.equal(recovered.find.get(id), undefined); assert.equal(recovered.used, 0); }
        assert.ok(!(await readdir(recovered.objects)).some(name => name.endsWith('.part')));
      } finally { recovered.close(); }
    }
  } finally { accounts.cleanup(); }
});
