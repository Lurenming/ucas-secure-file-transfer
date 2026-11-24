import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes, randomUUID, createHash, X509Certificate } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { temporaryAccounts } from '../test/helpers.js';
import { createAccount } from '../src/passwords.js';
import { createService } from '../src/service.js';
import { defaultCertDirectory, loadTlsOptions } from '../src/tls.js';

const accounts = temporaryAccounts(), directory = join(accounts.directory, 'csharp-enhanced'); mkdirSync(directory);
const password = randomBytes(24).toString('base64url');
let service, mtls, child, peak = 0, lost = false;
const sha = data => createHash('sha256').update(data).digest('hex');
try {
  await createAccount(accounts.store, 'alice', password); await createAccount(accounts.store, 'bob', password);
  const user = accounts.store.findByUsername('alice');
  accounts.store.db.prepare('INSERT INTO account_policy VALUES (?,?,?,?)').run(user.user_id, 'ordinary', 131072, 131072);
  service = createService({ accountStore: accounts.store, uploadOptions: { hooks: {
    afterCommit: item => { if (item.name === 'lost-confirmation.bin' && !lost) { lost = true; for (const ws of service.wss.clients) ws.terminate(); } }
  } } });
  for (let i = 0; i < 2; i++) {
    const bytes = randomBytes(262144), item = service.uploadStore.reserve(user.user_id, randomUUID(), 1, `seed-${i}.bin`, bytes.length);
    await service.uploadStore.create(item); await service.uploadStore.write(item, bytes); await service.uploadStore.publish(item, sha(bytes), () => {});
    writeFileSync(join(directory, `seed-${i}.bin`), bytes);
  }
  const key = join(directory, 'client.key'), csr = join(directory, 'client.csr'), cert = join(directory, 'client.crt'), ext = join(directory, 'client.cnf');
  const openssl = process.env.SFT_OPENSSL || 'openssl';
  const run = (...args) => execFileSync(openssl, args, { windowsHide: true, stdio: 'pipe' });
  run('genpkey', '-algorithm', 'RSA', '-pkeyopt', 'rsa_keygen_bits:2048', '-out', key);
  run('req', '-new', '-key', key, '-out', csr, '-subj', '/CN=client-display-only');
  writeFileSync(ext, 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=clientAuth\n');
  run('x509', '-req', '-in', csr, '-CA', join(defaultCertDirectory, 'public/dev-ca.crt'), '-CAkey', join(defaultCertDirectory, 'private/ca.key'), '-set_serial', '0x' + randomBytes(16).toString('hex'), '-days', '2', '-out', cert, '-extfile', ext);
  const x509 = new X509Certificate(readFileSync(cert));
  accounts.store.db.prepare('INSERT INTO client_certificates VALUES (?,?,0,?,?)').run(x509.fingerprint256.replaceAll(':', '').toLowerCase(), user.user_id, new Date(x509.validTo).toISOString(), new Date().toISOString());
  mtls = createService({ tlsOptions: loadTlsOptions(defaultCertDirectory, 'mtls-required'), authOptions: { mode: 'mtls-required' }, accountStore: accounts.store, uploadOptions: { directory: join(accounts.directory, 'mtls-uploads') } });
  for (const server of [service, mtls]) { server.server.listen(0, '127.0.0.1'); await once(server.server, 'listening'); }
  const timer = setInterval(() => { peak = Math.max(peak, service.uploadStore.active.size); }, 10);
  const assembly = fileURLToPath(new URL('../../SecureFileTransfer.Client/SecureFileTransfer.ConnectionChecks/bin/Debug/net10.0/SecureFileTransfer.ConnectionChecks.dll', import.meta.url));
  child = spawn('dotnet', [assembly, join(defaultCertDirectory, 'public/dev-ca.crt'), `wss://127.0.0.1:${service.server.address().port}/ws`, '--enhanced'], { windowsHide: true, stdio: ['pipe', 'inherit', 'inherit'] });
  child.stdin.end(JSON.stringify({ directory, password, clientCert: cert, clientKey: key, mtlsAddress: `wss://127.0.0.1:${mtls.server.address().port}/ws` }));
  const [code] = await once(child, 'exit'); clearInterval(timer); assert.equal(code, 0, 'Real enhanced C# client exited successfully');
  assert.ok(peak >= 4); console.log('Node observed concurrent active transfers:', peak);
  for (const row of service.uploadStore.list.all().filter(row => row.state === 'committed')) {
    const object = readFileSync(service.uploadStore.paths(row.file_id).final);
    assert.equal(object.length, row.size); assert.equal(sha(object), row.sha256);
    const source = join(directory, row.display_name); assert.equal(sha(readFileSync(source)), row.sha256);
    console.log('SOURCE_SERVER_HASH', JSON.stringify({ name: row.display_name, size: row.size, sha256: row.sha256 }));
  }
  for (const name of readdirSync(directory).filter(name => name.startsWith('download-'))) {
    const bytes = readFileSync(join(directory, name)), source = readFileSync(join(directory, name.slice(9)));
    assert.equal(sha(bytes), sha(source)); console.log('THREE_WAY_HASH', JSON.stringify({ name, size: bytes.length, sha256: sha(bytes) }));
  }
} catch (error) { console.error('Enhanced C# checks:', error); process.exitCode = 1; }
finally {
  if (child && child.exitCode === null) child.kill();
  await service?.stop(); await mtls?.stop(); accounts.cleanup();
}
