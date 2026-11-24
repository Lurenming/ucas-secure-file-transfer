import { parseArgs } from 'node:util';
import { mkdirSync, existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { X509Certificate, createPrivateKey, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { restrictPrivatePath } from '../src/private-storage.js';
import { loadTlsOptions } from '../src/tls.js';

const { positionals: [action, authority, output], values } = parseArgs({ allowPositionals: true, options: {
  ip: { type: 'string', multiple: true }, dns: { type: 'string', multiple: true }, name: { type: 'string' },
  days: { type: 'string', default: '90' }, pfx: { type: 'boolean', default: false }
} });
const run = (...args) => execFileSync('openssl', args, { windowsHide: true, stdio: 'pipe' });
function newDirectory(path) {
  if (!path || existsSync(resolve(path))) throw new Error('Destination must be a NEW directory; existing certificates are never overwritten');
  const directory = resolve(path); mkdirSync(directory, { recursive: true, mode: 0o700 }); restrictPrivatePath(directory); return directory;
}
try {
  if (action === 'init-ca') {
    const directory = newDirectory(authority);
    run('genpkey', '-algorithm', 'RSA', '-pkeyopt', 'rsa_keygen_bits:3072', '-out', join(directory, 'ca.key'));
    run('req', '-new', '-x509', '-sha256', '-days', '3650', '-key', join(directory, 'ca.key'), '-out', join(directory, 'ca.crt'),
      '-subj', '/CN=SFT Offline Root CA', '-addext', 'basicConstraints=critical,CA:TRUE,pathlen:0',
      '-addext', 'keyUsage=critical,keyCertSign,cRLSign', '-addext', 'subjectKeyIdentifier=hash');
    console.log('CA public SHA-256:', new X509Certificate(readFileSync(join(directory, 'ca.crt'))).fingerprint256);
  } else if (action === 'check') {
    const directory = resolve(authority); loadTlsOptions(directory, 'password');
    const ca = join(directory, 'public/dev-ca.crt'), cert = join(directory, 'public/server.crt');
    run('verify', '-CAfile', ca, '-purpose', 'sslserver', cert);
    for (const ip of values.ip ?? []) run('verify', '-CAfile', ca, '-purpose', 'sslserver', '-verify_ip', ip, cert);
    for (const name of values.dns ?? []) run('verify', '-CAfile', ca, '-purpose', 'sslserver', '-verify_hostname', name, cert);
    console.log('Chain, validity, serverAuth and key match verified. CA SHA-256:', new X509Certificate(readFileSync(ca)).fingerprint256);
  } else if (action === 'server' || action === 'client') {
    const days = Number(values.days);
    if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error('Leaf validity must be 1..365 days');
    const caPath = join(resolve(authority), 'ca.crt'), caKey = join(resolve(authority), 'ca.key');
    const ca = new X509Certificate(readFileSync(caPath));
    if (!ca.ca || !ca.checkPrivateKey(createPrivateKey(readFileSync(caKey))) || Date.now() + days * 86400000 > Date.parse(ca.validTo)) throw new Error('CA invalid or leaf would outlive CA');
    const ips = values.ip ?? ['127.0.0.1'], names = values.dns ?? ['localhost'];
    if (ips.some(ip => !isIP(ip) || ip === '0.0.0.0' || ip === '::') || names.some(name => !/^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(name))) throw new Error('Invalid IP/DNS SAN');
    if (action === 'client' && !/^[A-Za-z][A-Za-z0-9_]{2,31}$/.test(values.name ?? '')) throw new Error('Client --name required (display only; administrator binding is separate)');
    const directory = newDirectory(output), priv = join(directory, 'private'), pub = join(directory, 'public');
    mkdirSync(priv); restrictPrivatePath(priv); mkdirSync(pub);
    const key = join(priv, action + '.key'), cert = join(pub, action + '.crt');
    const csr = join(directory, 'request.csr'), extensions = join(directory, 'extensions.cnf');
    writeFileSync(join(pub, 'dev-ca.crt'), readFileSync(caPath), { flag: 'wx' });
    writeFileSync(extensions, `[leaf]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=${action === 'server' ? 'serverAuth' : 'clientAuth'}\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid,issuer\n${action === 'server' ? 'subjectAltName=' + [...ips.map(ip => 'IP:' + ip), ...names.map(name => 'DNS:' + name)].join(',') + '\n' : ''}`, { flag: 'wx' });
    run('genpkey', '-algorithm', 'RSA', '-pkeyopt', 'rsa_keygen_bits:3072', '-out', key);
    run('req', '-new', '-sha256', '-key', key, '-out', csr, '-subj', '/CN=' + (action === 'client' ? values.name : names[0] ?? ips[0]));
    run('x509', '-req', '-in', csr, '-CA', caPath, '-CAkey', caKey, '-set_serial', '0x' + randomBytes(16).toString('hex'), '-days', String(days), '-sha256', '-out', cert, '-extfile', extensions, '-extensions', 'leaf');
    run('verify', '-CAfile', caPath, '-purpose', action === 'server' ? 'sslserver' : 'sslclient', cert);
    const leaf = new X509Certificate(readFileSync(cert));
    if (!leaf.checkPrivateKey(createPrivateKey(readFileSync(key)))) throw new Error('Private key mismatch');
    if (action === 'server') {
      for (const ip of ips) run('verify', '-CAfile', caPath, '-purpose', 'sslserver', '-verify_ip', ip, cert);
      for (const name of names) run('verify', '-CAfile', caPath, '-purpose', 'sslserver', '-verify_hostname', name, cert);
    }
    if (values.pfx && action === 'client') {
      console.log('OpenSSL will prompt twice for an export password; do not use a command-line password.');
      execFileSync('openssl', ['pkcs12', '-export', '-inkey', key, '-in', cert, '-certfile', caPath, '-out', join(priv, 'client.pfx')], { stdio: 'inherit', windowsHide: true });
    }
    unlinkSync(csr); unlinkSync(extensions);
    console.log('Issued', action, 'SHA-256:', leaf.fingerprint256, '; expires:', leaf.validTo);
  } else throw new Error('Usage: pki.js init-ca NEW_CA_DIR | server CA_DIR NEW_DIR [--ip IP] [--dns DNS] | client CA_DIR NEW_DIR --name USER [--pfx]');
} catch (error) {
  console.error('PKI failed:', error.status ? 'OpenSSL rejected the operation; no existing certificate overwritten' : error.message); process.exitCode = 1;
}
