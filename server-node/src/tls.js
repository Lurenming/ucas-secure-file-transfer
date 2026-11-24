import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { X509Certificate, createPrivateKey } from 'node:crypto';
import { authMode } from './connection-config.js';
import { isIP } from 'node:net';

export const defaultCertDirectory = process.env.SFT_CERT_DIR ? resolve(process.env.SFT_CERT_DIR) : fileURLToPath(new URL('../certs/', import.meta.url));

export function loadTlsOptions(directory = process.env.SFT_CERT_DIR || defaultCertDirectory, mode = authMode()) {
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
    if (!leaf.subjectAltName) throw new Error('Missing server SAN');
    const name = process.env.SFT_SERVER_NAME;
    if (name && !(isIP(name) ? leaf.checkIP(name) : leaf.checkHost(name, { subject: 'never' }))) throw new Error('SFT_SERVER_NAME does not match certificate SAN');
    if (!leaf.keyUsage?.includes('1.3.6.1.5.5.7.3.1')) throw new Error('Missing serverAuth extended key usage');
    return { cert, key, ca: ca.toString(), requestCert: mode === 'mtls-required', rejectUnauthorized: true, minVersion: 'TLSv1.2', handshakeTimeout: 10000 };
  } catch (error) {
    throw new Error(`TLS certificates missing or invalid (${error.code ?? error.message}). Inspect ${base}; run npm run certs:dev for initial generation. No HTTP fallback.`);
  }
}
