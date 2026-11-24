// All faults below are SIMULATED. This does not fill a host disk or change global quotas.
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { createService } from '../src/service.js';
import { createAccount } from '../src/passwords.js';
import { defaultCertDirectory } from '../src/tls.js';
import assert from 'node:assert/strict';
const root = resolve(process.argv[2]);
assert.ok(root.startsWith(resolve('../artifacts/acceptance-20261125') + '\\') && !existsSync(root), 'Fresh scoped fixture only');
mkdirSync(root, { recursive: true }); process.env.SFT_DATA_DIR = join(root, 'data');
const service = createService(), store = service.uploadStore, password = randomBytes(24).toString('base64url');
const fired = new Set(), evidence = [];
const failure = phase => { fired.add(phase); const error = new Error('SIMULATED ' + (['checkpoint', 'precommit', 'commit'].includes(phase) ? 'SQLITE_FULL' : 'ENOSPC')); error.code = phase === 'write' || phase === 'flush' ? 'ENOSPC' : 'SQLITE_FULL'; return error; };
const selected = (item, phase) => item.name === `fault-${phase}.bin` && !fired.has(phase);
const originalWrite = store.write.bind(store), originalCheckpoint = store.checkpoint.bind(store);
store.write = async (item, bytes) => {
  if (selected(item, 'write') && item.received >= 8192) { await originalWrite(item, bytes.subarray(0, 117)); throw failure('write'); }
  return originalWrite(item, bytes);
};
store.checkpoint = async item => {
  if (item.received > 8192 && selected(item, 'flush')) throw failure('flush');
  if (item.received > 8192 && selected(item, 'checkpoint')) { await item.handle.sync(); throw failure('checkpoint'); }
  return originalCheckpoint(item);
};
for (const [field, phase] of [['precommit', 'precommit'], ['commit', 'commit']]) {
  const statement = store[field]; store[field] = { run(...args) {
    const row = store.find.get(args[2]);
    if (row.display_name === `fault-${phase}.bin` && !fired.has(phase)) throw failure(phase);
    return statement.run(...args);
  } };
}
let child, timer;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
try {
  for (const name of ['alice', 'bob']) await createAccount(service.authentication.store, name, password);
  const owner = service.authentication.store.findByUsername('alice').user_id;
  const seed = randomBytes(65539), item = store.reserve(owner, randomUUID(), 0, 'seed.bin', seed.length);
  await store.create(item); await originalWrite(item, seed); await store.publish(item, sha(seed), () => {});
  service.server.listen(0, '127.0.0.1'); await once(service.server, 'listening');
  const assembly = resolve('../SecureFileTransfer.Client/SecureFileTransfer.ConnectionChecks/bin/Debug/net10.0/SecureFileTransfer.ConnectionChecks.dll');
  child = spawn('dotnet', [assembly, join(defaultCertDirectory, 'public/dev-ca.crt'), `wss://127.0.0.1:${service.server.address().port}/ws`, '--storage-faults'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const result = once(child, 'exit'); let errors = ''; child.stderr.on('data', b => { errors += b; });
  const lines = createInterface({ input: child.stdout });
  child.stdin.write(JSON.stringify({ directory: root, password }) + '\n');
  timer = setTimeout(() => child.kill(), 180000);
  for await (const line of lines) {
    const event = JSON.parse(line); evidence.push(event);
    if (event.kind === 'serverFault') {
      for (let attempt = 0; store.active.size && attempt < 100; attempt++) await new Promise(r => setTimeout(r, 10));
      const row = store.find.get(event.id);
      assert.equal(row.state, 'receiving'); assert.equal(row.durable_offset, event.confirmed);
      assert.equal(existsSync(store.paths(event.id).final), false); assert.equal(store.active.size, 0);
      assert.equal(store.find.get(event.survivor).state, 'committed'); assert.ok(!store.failed);
    }
    if (event.kind === 'recovered') {
      const row = store.find.get(event.id), bytes = readFileSync(store.paths(event.id).final);
      assert.equal(row.state, 'committed'); assert.equal(bytes.length, event.size); assert.equal(sha(bytes), event.sha256);
      assert.equal(sha(readFileSync(join(root, row.display_name))), event.sha256);
    }
    if (event.kind === 'done') {
      for (let attempt = 0; (store.active.size || service.wss.clients.size) && attempt < 100; attempt++) await new Promise(r => setTimeout(r, 10));
      assert.equal(store.active.size, 0); assert.equal(service.wss.clients.size, 0); assert.equal(fired.size, 5);
    }
    console.log(JSON.stringify(event)); child.stdin.write('ok\n');
  }
  const [code] = await result; assert.equal(code, 0, errors);
  writeFileSync(join(root, 'result.json'), JSON.stringify({ simulated: true, realDiskFull: false, passed: true, events: evidence, activeAfter: store.active.size, connectionsAfter: service.wss.clients.size }, null, 2));
} catch (error) { console.error(error); process.exitCode = 1; }
finally { clearTimeout(timer); if (child?.exitCode === null) child.kill(); await service.stop(); }
