import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { X509Certificate, createPrivateKey } from 'node:crypto';

export const defaultCertDirectory = fileURLToPath(new URL('../certs/', import.meta.url));

export function loadTlsOptions(directory = process.env.SFT_CERT_DIR || defaultCertDirectory) {
  const base = resolve(directory);
  try {
    const cert = readFileSync(join(base, 'public/server.crt'));
    const key = readFileSync(join(base, 'private/server.key'));
    const ca = new X509Certificate(readFileSync(join(base, 'public/dev-ca.crt')));
    const leaf = new X509Certificate(cert);
    const now = Date.now();
    for (const item of [ca, leaf]) {
      if (now < Date.parse(item.validFrom) || now > Date.parse(item.validTo)) throw new Error('Certificate is not currently valid');
    }
    if (!ca.ca || !ca.verify(ca.publicKey) || leaf.ca || !leaf.checkIssued(ca) || !leaf.verify(ca.publicKey)) {
      throw new Error('Invalid development CA or certificate chain');
    }
    if (!leaf.checkPrivateKey(createPrivateKey(key))) throw new Error('Server certificate and private key do not match');
    if (!leaf.checkHost('localhost', { subject: 'never' }) || !leaf.checkIP('127.0.0.1')) throw new Error('Missing localhost/127.0.0.1 SAN');
    if (!leaf.keyUsage?.includes('1.3.6.1.5.5.7.3.1')) throw new Error('Missing serverAuth extended key usage');
    return { cert, key, minVersion: 'TLSv1.2', handshakeTimeout: 10000 };
  } catch (error) {
    throw new Error(`TLS certificates missing or invalid (${error.code ?? error.message}). Inspect ${base}; run npm run certs:dev for initial generation. No HTTP fallback.`);
  }
}
