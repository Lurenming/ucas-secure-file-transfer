// One-time creation of a disposable course acceptance environment. Never touches production data.
import { mkdirSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes, randomUUID, createHash, X509Certificate } from 'node:crypto';
import { openAccounts } from '../src/accounts.js';
import { createAccount } from '../src/passwords.js';
import { createService } from '../src/service.js';
import { loadTlsOptions } from '../src/tls.js';
const project = fileURLToPath(new URL('../../', import.meta.url));
const root = join(project, 'artifacts/acceptance-20261125/manual');
if (existsSync(root)) throw new Error('Manual fixture already exists; refusing to replace any acceptance data');
mkdirSync(root, { recursive: true }); writeFileSync(join(root, '.sft-acceptance'), 'isolated acceptance 2026-11-25\n');
const ca = join(root, 'offline-ca'), certs = join(root, 'certs');
const pki = (...args) => execFileSync(process.execPath, [join(project, 'server-node/scripts/pki.js'), ...args], { stdio: 'pipe', windowsHide: true });
pki('init-ca', ca); pki('server', ca, certs, '--ip', '127.0.0.1', '--dns', 'localhost');
const users = [
  { username: 'accept_alice', password: 'Lab25-Ordinary-Only!', tier: 'ordinary', rate: 65536 },
  { username: 'accept_bob', password: 'Lab25-Vip-Only!', tier: 'vip', rate: 262144 }
];
const pfxPassword = 'Lab25-Pfx-Only!'; // Publicly documented synthetic fixture credential, not a real user password.
for (const user of users) {
  user.certificateDirectory = join(root, user.username);
  pki('client', ca, user.certificateDirectory, '--name', user.username);
  execFileSync('openssl', ['pkcs12', '-export', '-inkey', join(user.certificateDirectory, 'private/client.key'), '-in', join(user.certificateDirectory, 'public/client.crt'),
    '-certfile', join(ca, 'ca.crt'), '-out', join(user.certificateDirectory, 'private/client.pfx'), '-passout', 'stdin'], { input: pfxPassword + '\n', windowsHide: true });
}
const sources = join(root, 'upload-files'); mkdirSync(sources);
const sourceManifest = [];
for (const [name, size] of [['空文件.bin', 0], ['边界-8193.bin', 8193], ['小文件-48017.bin', 48017], ['上传-甲-2MiB.bin', 2097152], ['上传-乙-2MiB.bin', 2097152]]) {
  const bytes = randomBytes(size); writeFileSync(join(sources, name), bytes);
  sourceManifest.push({ name, size, sha256: createHash('sha256').update(bytes).digest('hex') });
}
const modes = {};
for (const mode of ['password', 'mtls']) {
  const data = join(root, mode + '-data'), client = join(root, 'client-' + mode), downloads = join(root, 'downloads-' + mode);
  mkdirSync(client); mkdirSync(downloads);
  const accounts = openAccounts(data);
  for (const user of users) {
    const account = await createAccount(accounts, user.username, user.password);
    accounts.db.prepare('INSERT INTO account_policy VALUES (?,?,?,?)').run(account.userId, user.tier, user.rate, user.rate);
    const cert = new X509Certificate(readFileSync(join(user.certificateDirectory, 'public/client.crt')));
    accounts.db.prepare('INSERT INTO client_certificates VALUES (?,?,0,?,?)').run(cert.fingerprint256.replaceAll(':', '').toLowerCase(), account.userId, new Date(cert.validTo).toISOString(), new Date().toISOString());
  }
  const authMode = mode === 'mtls' ? 'mtls-required' : 'password';
  const service = createService({ accountStore: accounts, tlsOptions: loadTlsOptions(certs, authMode), authOptions: { mode: authMode }, uploadOptions: { directory: join(data, 'uploads'), policy: { quotaBytes: 128 * 1024 * 1024 } } });
  const files = [];
  for (const user of users) for (const [name, size] of [['下载-甲-2MiB.bin', 2097152], ['下载-乙-2MiB.bin', 2097152], ['下载-小文件.bin', 48017]]) {
    const bytes = randomBytes(size), hash = createHash('sha256').update(bytes).digest('hex');
    const owner = accounts.findByUsername(user.username).user_id;
    const item = service.uploadStore.reserve(owner, randomUUID(), 0, name, size);
    await service.uploadStore.create(item); await service.uploadStore.write(item, bytes); await service.uploadStore.publish(item, hash, () => {});
    files.push({ owner: user.username, fileId: item.id, name, size, sha256: hash });
  }
  service.server.listen(0, '127.0.0.1'); await once(service.server, 'listening'); const port = service.server.address().port;
  writeFileSync(join(client, 'connection.json'), JSON.stringify({ Host: '127.0.0.1', Port: port, PublicCa: join(certs, 'public/dev-ca.crt'), Concurrency: 4 }, null, 2));
  modes[mode] = { data, client, downloads, port, files, authMode };
  await service.stop(); accounts.close();
}
const manifest = { root, certs, publicCa: join(certs, 'public/dev-ca.crt'), caFingerprintSha256: new X509Certificate(readFileSync(join(certs, 'public/dev-ca.crt'))).fingerprint256,
  sources, sourceManifest, modes, users, pfxPassword, syntheticCredentialsOnly: true, preparedAt: new Date().toISOString(), quotaBytesPerServer: 128 * 1024 * 1024 };
writeFileSync(join(root, 'fixture.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ prepared: root, passwordPort: modes.password.port, mtlsPort: modes.mtls.port, files: sourceManifest.length, publicCa: manifest.publicCa, caFingerprintSha256: manifest.caFingerprintSha256 }));
