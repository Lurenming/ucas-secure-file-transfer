import { readFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import { openAccounts, normalizeUsername } from '../src/accounts.js';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { defaultCertDirectory } from '../src/tls.js';
const [action, username, ...args] = process.argv.slice(2);
let store;
try {
  store = openAccounts();
  const user = store.findByUsername(normalizeUsername(username));
  if (!user) throw new Error('Account not found');
  if (action === 'tier') {
    const [tier, up, down] = args, upload = Number(up), download = Number(down);
    if (!['ordinary', 'vip'].includes(tier) || ![upload, download].every(n => Number.isInteger(n) && n >= 8192 && n <= 104857600)) throw new Error('tier USER ordinary|vip UPLOAD_BYTES_PER_SEC DOWNLOAD_BYTES_PER_SEC (8192..104857600)');
    store.db.prepare('INSERT INTO account_policy VALUES (?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET tier=excluded.tier,upload_bps=excluded.upload_bps,download_bps=excluded.download_bps').run(user.user_id, tier, upload, download);
    console.log('Account bandwidth policy updated:', username, tier, upload, download, 'bytes/second separately');
  } else if (action === 'bind' || action === 'replace') {
    const path = resolve(args[0]), ca = join(process.env.SFT_CERT_DIR || defaultCertDirectory, 'public/dev-ca.crt');
    execFileSync('openssl', ['verify', '-CAfile', ca, '-purpose', 'sslclient', path], { windowsHide: true, stdio: 'pipe' });
    const cert = new X509Certificate(readFileSync(path));
    if (cert.ca || !cert.keyUsage?.includes('1.3.6.1.5.5.7.3.2')) throw new Error('Explicit clientAuth certificate required');
    const fingerprint = cert.fingerprint256.replaceAll(':', '').toLowerCase();
    store.db.exec('BEGIN IMMEDIATE');
    try {
      if (action === 'replace') store.db.prepare('UPDATE client_certificates SET disabled=1 WHERE user_id=?').run(user.user_id);
      store.db.prepare('INSERT INTO client_certificates VALUES (?,?,0,?,?)').run(fingerprint, user.user_id, new Date(cert.validTo).toISOString(), new Date().toISOString());
      store.db.exec('COMMIT');
    } catch (error) { store.db.exec('ROLLBACK'); throw error; }
    console.log('Certificate bound to', username, 'SHA-256:', fingerprint);
  } else if (action === 'disable') {
    if (!/^[a-f0-9]{64}$/i.test(args[0])) throw new Error('Supply full certificate SHA-256 without colons');
    const result = store.db.prepare('UPDATE client_certificates SET disabled=1 WHERE fingerprint=? AND user_id=?').run(args[0].toLowerCase(), user.user_id);
    if (!result.changes) throw new Error('No such binding');
    console.log('Disabled; new authentication fails immediately, active sessions rechecked at each operation and within one second.');
  } else if (action === 'show') {
    console.log(JSON.stringify({ username, ...store.policy(user.user_id), certificates: store.db.prepare('SELECT fingerprint,disabled,not_after FROM client_certificates WHERE user_id=?').all(user.user_id) }, null, 2));
  } else throw new Error('Usage: admin.js tier|bind|replace|disable|show USER ...');
} catch (error) { console.error('Admin operation failed:', error.status ? 'Certificate validation failed' : error.message); process.exitCode = 1; }
finally { store?.close(); }
