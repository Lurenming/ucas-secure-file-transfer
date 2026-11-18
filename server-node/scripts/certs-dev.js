import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, renameSync, rmSync, readFileSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, X509Certificate } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const destination = join(root, 'certs');
const expected = ['public/dev-ca.crt', 'public/server.crt', 'private/ca.key', 'private/server.key'];
let temporary;
try {
  if (existsSync(destination)) {
    if (!expected.every((name) => existsSync(join(destination, name)))) {
      throw new Error('certs exists but is incomplete. Inspect it manually; no files were overwritten.');
    }
    console.log('[certs] Existing certificates preserved. No files or trust stores changed.');
  } else {
    const version = execFileSync('openssl', ['version'], { encoding: 'utf8', windowsHide: true }).trim();
    console.log(`[certs] Using ${version}`);
    temporary = mkdtempSync(join(root, '.certs-dev-'));
    const privateDir = join(temporary, 'private');
    const publicDir = join(temporary, 'public');
    mkdirSync(privateDir, { mode: 0o700 });
    mkdirSync(publicDir);
    if (process.platform === 'win32') {
      const identity = execFileSync('whoami', [], { encoding: 'utf8', windowsHide: true }).trim();
      execFileSync('icacls.exe', [privateDir, '/inheritance:r', '/grant:r', `${identity}:(OI)(CI)F`], { stdio: 'pipe', windowsHide: true });
    }
    const configuration = join(temporary, 'openssl.cnf');
    writeFileSync(configuration, `[req]
distinguished_name = dn
prompt = no
[dn]
CN = SecureFileTransfer Development CA
[ca]
basicConstraints = critical,CA:TRUE,pathlen:0
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always
[server]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = DNS:localhost,IP:127.0.0.1
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid,issuer
`);
    const run = (...args) => {
      try { return execFileSync('openssl', args, { stdio: 'pipe', windowsHide: true }); }
      catch { throw new Error('OpenSSL certificate command failed (output withheld)'); }
    };
    const caKey = join(privateDir, 'ca.key');
    const serverKey = join(privateDir, 'server.key');
    const ca = join(publicDir, 'dev-ca.crt');
    const server = join(publicDir, 'server.crt');
    const csr = join(temporary, 'server.csr');
    run('genpkey', '-algorithm', 'RSA', '-pkeyopt', 'rsa_keygen_bits:3072', '-out', caKey);
    run('req', '-new', '-x509', '-sha256', '-days', '365', '-key', caKey, '-out', ca, '-config', configuration, '-extensions', 'ca');
    run('genpkey', '-algorithm', 'RSA', '-pkeyopt', 'rsa_keygen_bits:3072', '-out', serverKey);
    run('req', '-new', '-sha256', '-key', serverKey, '-out', csr, '-subj', '/CN=localhost', '-config', configuration);
    run('x509', '-req', '-in', csr, '-CA', ca, '-CAkey', caKey, '-set_serial', `0x${randomBytes(16).toString('hex')}`, '-days', '90', '-sha256', '-out', server, '-extfile', configuration, '-extensions', 'server');
    run('verify', '-CAfile', ca, '-purpose', 'sslserver', '-verify_hostname', 'localhost', server);
    run('verify', '-CAfile', ca, '-purpose', 'sslserver', '-verify_ip', '127.0.0.1', server);
    rmSync(csr);
    rmSync(configuration);
    renameSync(temporary, destination);
    temporary = undefined;
    const fingerprint = new X509Certificate(readFileSync(join(destination, 'public/dev-ca.crt'))).fingerprint256;
    console.log(`[certs] Created certificates. Public CA SHA-256: ${fingerprint}`);
    console.log('[certs] Select certs/public/dev-ca.crt in the client from this trusted local directory. No Windows root store was modified.');
  }
} catch (error) {
  // Do not print subprocess output: private key material must never reach logs.
  console.error(`[certs] Generation failed: ${error.code ?? error.message}. Requires an existing OpenSSL on PATH.`);
  process.exitCode = 1;
} finally {
  if (temporary && dirname(resolve(temporary)) === resolve(root) && basename(temporary).startsWith('.certs-dev-')) {
    rmSync(temporary, { recursive: true, force: true }); // Verified direct child created by this invocation.
  }
}
