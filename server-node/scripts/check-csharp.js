import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:https';
import { randomUUID, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { mkdir, stat, writeFile, unlink, truncate, readdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { encodeChunk } from '../src/upload-protocol.js';
import { encodeDownloadChunk } from '../src/download-protocol.js';
import { WebSocketServer } from 'ws';
import { createService } from '../src/service.js';
import { loadTlsOptions, defaultCertDirectory } from '../src/tls.js';
import { temporaryAccounts } from '../test/helpers.js';
import { createAccount } from '../src/passwords.js';

// Isolated test fixtures; never exposed by npm start.
const accounts = temporaryAccounts();
const service = createService({ accountStore: accounts.store });
const expiring = createService({ accountStore: accounts.store, authOptions: { sessionMs: 600 }, uploadOptions: { directory: join(accounts.directory, 'expiring-uploads') } });
const waiting = createService({ accountStore: accounts.store, authOptions: { unauthenticatedMs: 750 }, uploadOptions: { directory: join(accounts.directory, 'waiting-uploads') } });
const lostAck = createService({ accountStore: accounts.store, uploadOptions: { directory: join(accounts.directory, 'lost-ack-uploads'),
  hooks: { afterCommit: () => { for (const client of lostAck.wss.clients) client.terminate(); } } } });
const stoppingUpload = createService({ accountStore: accounts.store, uploadOptions: { directory: join(accounts.directory, 'stopping-uploads') } });
const stoppingDownload = createService({ accountStore: accounts.store, uploadOptions: { directory: join(accounts.directory, 'stopping-downloads') } });
// Fragment every real backend download frame to exercise the client's single receive loop.
service.wss.on('connection', ws => {
  const send = ws.send.bind(ws);
  ws.send = (data, options, callback) => {
    if (Buffer.isBuffer(data) && data.subarray(0, 4).toString() === 'SFTD') {
      send(data.subarray(0, 37), { ...options, fin: false });
      return send(data.subarray(37), { ...options, fin: true }, callback);
    }
    return send(data, options, callback);
  };
});
const fixture = createServer(loadTlsOptions());
const wss = new WebSocketServer({ server: fixture, path: '/ws', perMessageDeflate: false, maxPayload: 16384 });
wss.on('connection', (ws) => {
  ws.on('error', () => {});
  const connectionId = randomUUID();
  const fragmented = (message) => {
    const body = JSON.stringify(message);
    ws.send(body.slice(0, 12), { fin: false });
    ws.send(body.slice(12), { fin: true });
  };
  fragmented({ version: 1, type: 'HELLO', connectionId });
  ws.on('message', (raw) => {
    const request = JSON.parse(raw.toString());
    if (request.type === 'AUTH_LOGIN') {
      const requestId = request.requestId;
      delete request.data.password;
      const timer = setTimeout(() => {
        if (ws.readyState === 1) fragmented({ version: 1, type: 'AUTH_LOGIN_RESULT', requestId, connectionId,
          data: { userId: randomUUID(), username: 'alice', expiresAt: new Date(Date.now() + 60000).toISOString() } });
      }, 100);
      ws.once('close', () => clearTimeout(timer));
      return;
    }
    if (request.type === 'AUTH_LOGOUT') return fragmented({ version: 1, type: 'AUTH_LOGOUT_RESULT', requestId: request.requestId, connectionId, data: {} });
    if (request.type === 'FILES_LIST') {
      const timer = setTimeout(() => { if (ws.readyState === 1) fragmented({ version: 1, type: 'FILES_LIST_RESULT', requestId: request.requestId, connectionId, data: { files: [], nextCursor: null } }); }, 100);
      ws.once('close', () => clearTimeout(timer)); return;
    }
    if (request.data.text === 'oversize') return ws.send('x'.repeat(16385));
    if (request.data.text === 'binary') return ws.send(Buffer.from('binary'));
    if (request.data.text === 'bad-json') return ws.send('{');
    fragmented({ ...request, type: 'ECHO_RESULT', connectionId });
  });
});
let child;
const password = randomBytes(24).toString('base64url');
try {
  await createAccount(accounts.store, 'alice', password);
  await createAccount(accounts.store, 'bob', password);
  service.server.listen(0, '127.0.0.1');
  await once(service.server, 'listening');
  fixture.listen(0, '127.0.0.1');
  await once(fixture, 'listening');
  for (const extra of [expiring, waiting, lostAck, stoppingUpload, stoppingDownload]) { extra.server.listen(0, '127.0.0.1'); await once(extra.server, 'listening'); }
  const sourceDirectory = join(accounts.directory, 'csharp-sources'); await mkdir(sourceDirectory);
  const downloadDirectory = join(accounts.directory, 'csharp-downloads'); await mkdir(downloadDirectory);
  async function seed(target, name) {
    const bytes = randomBytes(48017), store = target.uploadStore;
    const item = store.reserve(accounts.store.findByUsername('alice').user_id, randomUUID(), 1, name, bytes.length);
    await store.create(item); await store.write(item, bytes);
    await store.publish(item, createHash('sha256').update(bytes).digest('hex'), () => {});
    return item.id;
  }
  const expiryFileId = await seed(expiring, 'expiry-download.bin');
  const downloadStopFileId = await seed(stoppingDownload, 'stop-download.bin');
  const damagedFileIds = [];
  for (const mode of ['missing', 'truncated', 'corrupt']) {
    const id = await seed(service, mode + '.bin'), path = service.uploadStore.paths(id).final;
    damagedFileIds.push(id);
    if (mode === 'missing') await unlink(path);
    else if (mode === 'truncated') await truncate(path, 1);
    else await writeFile(path, randomBytes(48017));
  }
  const assembly = fileURLToPath(new URL('../../SecureFileTransfer.Client/SecureFileTransfer.ConnectionChecks/bin/Debug/net10.0/SecureFileTransfer.ConnectionChecks.dll', import.meta.url));
  child = spawn('dotnet', [assembly, join(defaultCertDirectory, 'public/dev-ca.crt'), `wss://127.0.0.1:${service.server.address().port}/ws`, `wss://127.0.0.1:${fixture.address().port}/ws`, '--auth-stdin', '--expect-server-stop', '--tls-fixture-script', fileURLToPath(new URL('./tls-negative-fixture.js', import.meta.url))], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, SFT_NODE_EXECUTABLE: process.execPath, SFT_NODE_VERSION: process.version } });
  child.stdin.on('error', () => {});
  child.stdin.end(JSON.stringify({ username: 'alice', secondUsername: 'bob', password,
    expiryAddress: `wss://127.0.0.1:${expiring.server.address().port}/ws`, waitingAddress: `wss://127.0.0.1:${waiting.server.address().port}/ws`,
    sourceDirectory, downloadDirectory, expiryFileId, downloadStopFileId, damagedFileIds,
    downloadStopAddress: `wss://127.0.0.1:${stoppingDownload.server.address().port}/ws`,
    lostAckAddress: `wss://127.0.0.1:${lostAck.server.address().port}/ws`, stoppingAddress: `wss://127.0.0.1:${stoppingUpload.server.address().port}/ws` }) + '\n');
  let output = '';
  let committedRows, mainStopRequested = false;
  child.stdout.on('data', (data) => {
    output += data.toString();
    if (output.includes('READY_FOR_SERVER_STOP') && !mainStopRequested) {
      mainStopRequested = true; committedRows = service.uploadStore.list.all(); void service.stop();
    }
    if (output.includes('READY_FOR_UPLOAD_STOP')) void stoppingUpload.stop();
    if (output.includes('READY_FOR_DOWNLOAD_STOP')) void stoppingDownload.stop();
  });
  child.stderr.on('data', (data) => { output += data.toString(); });
  console.log('Running real C# TLS/auth/upload/download/disk checks and 61-second idle; all accounts and files are isolated.');
  const deadline = setTimeout(() => { child.kill(); }, 180000);
  try {
    const [code] = await once(child, 'exit');
    const record = accounts.store.findByUsername('alice');
    if ([password, Buffer.from(record.password_hash).toString('hex'), Buffer.from(record.password_hash).toString('base64')].some(secret => output.includes(secret))) {
      throw new Error('Sensitive test output suppressed');
    }
    process.stdout.write(output);
    if (code !== 0) throw new Error(`C# checks exited ${code}`);
    const header = output.split(/\r?\n/).find(line => line.startsWith('UPLOAD_HEADER_HEX:'))?.slice('UPLOAD_HEADER_HEX:'.length);
    assert.equal(header, encodeChunk('00112233-4455-4677-8899-aabbccddeeff', 'ffeeddcc-bbaa-4988-8776-554433221100', 0x01020304, Buffer.from([0xa5])).toString('hex'));
    const downloadHeader = output.split(/\r?\n/).find(line => line.startsWith('DOWNLOAD_HEADER_HEX:'))?.slice('DOWNLOAD_HEADER_HEX:'.length);
    assert.equal(downloadHeader, encodeDownloadChunk('00112233-4455-4677-8899-aabbccddeeff', 'ffeeddcc-bbaa-4988-8776-554433221100', 0x01020304, Buffer.from([0xa5])).toString('hex'));
    async function hashFile(path) { const hash = createHash('sha256'); for await (const bytes of createReadStream(path)) hash.update(bytes); return hash.digest('hex'); }
    for (const line of output.split(/\r?\n/).filter(line => line.startsWith('UPLOAD_RESULT:'))) {
      const result = JSON.parse(line.slice('UPLOAD_RESULT:'.length));
      const row = committedRows.find(row => row.file_id === result.fileId);
      const source = join(sourceDirectory, result.source);
      const stored = service.uploadStore.paths(result.fileId).final;
      assert.equal(row.state, 'committed'); assert.equal(row.owner_id, accounts.store.findByUsername(result.username).user_id);
      assert.equal((await stat(stored)).size, (await stat(source)).size);
      assert.equal(await hashFile(stored), await hashFile(source)); assert.equal(row.sha256, await hashFile(source));
    }
    let downloadCount = 0;
    for (const line of output.split(/\r?\n/).filter(line => line.startsWith('DOWNLOAD_RESULT:'))) {
      const result = JSON.parse(line.slice('DOWNLOAD_RESULT:'.length)), row = committedRows.find(row => row.file_id === result.fileId);
      assert.equal(row.owner_id, accounts.store.findByUsername(result.username).user_id);
      const paths = [join(sourceDirectory, result.source), service.uploadStore.paths(result.fileId).final, join(downloadDirectory, result.download)];
      for (const path of paths) { assert.equal((await stat(path)).size, row.size); assert.equal(await hashFile(path), row.sha256); }
      downloadCount++;
    }
    assert.ok(downloadCount >= 7);
    assert.ok(!(await readdir(downloadDirectory)).some(name => name.endsWith('.part')));
    const kept = lostAck.uploadStore.list.all();
    assert.equal(kept.length, 1); assert.equal(kept[0].state, 'committed');
    assert.equal(await hashFile(lostAck.uploadStore.paths(kept[0].file_id).final), await hashFile(join(sourceDirectory, 'ack-loss.bin')));
    assert.equal(stoppingUpload.uploadStore.closed, true);
    assert.equal(stoppingDownload.uploadStore.closed, true);
    assert.equal(service.uploadStore.active.size, 0); assert.equal(expiring.uploadStore.active.size, 0);
    console.log(`PASS: both C#/JS headers identical; ${downloadCount} source/server/download triplets independently hashed; handles and temp files cleaned; lost upload ACK preserves committed file.`);
  } finally { clearTimeout(deadline); }
} catch (error) {
  console.error(`[C# checks] ${error.code ?? error.message}`);
  process.exitCode = 1;
} finally {
  await service.stop();
  await expiring.stop();
  await waiting.stop();
  await lostAck.stop();
  await stoppingUpload.stop();
  await stoppingDownload.stop();
  for (const ws of wss.clients) ws.terminate();
  await new Promise((resolve) => wss.close(resolve));
  if (fixture.listening) await new Promise((resolve) => fixture.close(resolve));
  accounts.cleanup();
}
