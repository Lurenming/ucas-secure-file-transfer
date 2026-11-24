// Exercise the real administrator commands, only in an owned temporary directory.
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { X509Certificate, randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { openAccounts } from '../src/accounts.js';
import { createAccount } from '../src/passwords.js';

const root = mkdtempSync(join(tmpdir(), 'sft-pki-cli-'));
const ca = join(root, 'offline-ca'), server = join(root, 'server'), client = join(root, 'alice'), replacement = join(root, 'replacement');
const env = { ...process.env, SFT_DATA_DIR: join(root, 'data'), SFT_CERT_DIR: server };
function run(script, args, success = true) {
  const result = spawnSync(process.execPath, [script, ...args], { env, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.equal(result.error, undefined);
  if (success) assert.equal(result.status, 0, result.stderr);
  else assert.notEqual(result.status, 0, 'Command should reject invalid input');
  return result.stdout;
}
try {
  run('scripts/pki.js', ['init-ca', ca]);
  run('scripts/pki.js', ['server', ca, server, '--ip', '127.0.0.1', '--dns', 'localhost', '--dns', 'sft.test']);
  run('scripts/pki.js', ['check', server, '--ip', '127.0.0.1', '--dns', 'sft.test']);
  run('scripts/pki.js', ['check', server, '--dns', 'wrong.example'], false);
  const certBefore = readFileSync(join(server, 'public/server.crt'));
  run('scripts/pki.js', ['server', ca, server], false);
  assert.deepEqual(readFileSync(join(server, 'public/server.crt')), certBefore);
  assert.equal(existsSync(join(server, 'private/ca.key')), false);
  run('scripts/pki.js', ['client', ca, client, '--name', 'alice']);
  run('scripts/pki.js', ['client', ca, replacement, '--name', 'display_only']);
  let store = openAccounts(env.SFT_DATA_DIR);
  await createAccount(store, 'alice', randomBytes(24).toString('base64url'));
  await createAccount(store, 'bob', randomBytes(24).toString('base64url')); store.close();
  run('scripts/admin.js', ['tier', 'alice', 'vip', '65536', '262144']);
  run('scripts/admin.js', ['bind', 'alice', join(client, 'public/client.crt')]);
  run('scripts/admin.js', ['bind', 'bob', join(client, 'public/client.crt')], false);
  run('scripts/admin.js', ['bind', 'alice', join(server, 'public/server.crt')], false);
  run('scripts/admin.js', ['replace', 'alice', join(replacement, 'public/client.crt')]);
  const policy = JSON.parse(run('scripts/admin.js', ['show', 'alice']));
  assert.equal(policy.tier, 'vip'); assert.equal(policy.upload_bps, 65536); assert.equal(policy.download_bps, 262144);
  assert.equal(policy.certificates.length, 2); assert.equal(policy.certificates.filter(c => c.disabled === 0).length, 1);
  const fingerprint = new X509Certificate(readFileSync(join(replacement, 'public/client.crt'))).fingerprint256.replaceAll(':', '').toLowerCase();
  run('scripts/admin.js', ['disable', 'alice', fingerprint]);
  assert.ok(JSON.parse(run('scripts/admin.js', ['show', 'alice'])).certificates.every(c => c.disabled === 1));
  console.log('PASS: real CA/server/client issuance, SAN and purpose checks, no overwrite, no runtime CA key, account binding uniqueness, replace, disable and tier commands');
  console.log('NOT TESTED: interactive PFX export password prompt and GUI certificate selection');
} finally { rmSync(root, { recursive: true, force: true }); }
