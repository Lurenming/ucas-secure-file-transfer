import { readFileSync, writeFileSync, unlinkSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { get } from 'node:https';
import assert from 'node:assert/strict';
const directory = resolve('artifacts/acl-deployment');
process.env.SFT_DATA_DIR = join(directory, 'data'); process.env.SFT_CERT_DIR = join(directory, 'certs');
process.env.SFT_ACL_MODE = 'verify';
process.env.SFT_STORAGE_SID = 'S-1-5-21-3223580224-2204529523-3121273334-1005';
process.env.SFT_DEPLOY_ADMIN_SID = 'S-1-5-21-3223580224-2204529523-3121273334-1001';
const { createService } = await import(pathToFileURL(join(directory, 'app/server-node/src/service.js')));
const { createAccount } = await import(pathToFileURL(join(directory, 'app/server-node/src/passwords.js')));
const service = createService();
try {
  await createAccount(service.authentication.store, 'acl' + randomBytes(5).toString('hex'), randomBytes(24).toString('hex'));
  service.server.listen(0, '127.0.0.1'); await once(service.server, 'listening');
  const status = await new Promise((resolve, reject) => get({ hostname: '127.0.0.1', port: service.server.address().port, path: '/health', ca: readFileSync(join(directory, 'certs/public/dev-ca.crt')) }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); }).on('error', reject));
  assert.equal(status, 200);
  const deniedRead = path => { try { readFileSync(path); return false; } catch (error) { if (error.code === 'EACCES' || error.code === 'EPERM') return true; throw error; } };
  const deniedWrite = path => {
    const probe = join(path, 'boundary-' + randomBytes(8).toString('hex'));
    try { writeFileSync(probe, 'test', { flag: 'wx' }); unlinkSync(probe); return false; }
    catch (error) { if (error.code === 'EACCES' || error.code === 'EPERM') return true; throw error; }
  };
  const boundaries = {
    appWriteDenied: deniedWrite(join(directory, 'app')),
    configWriteDenied: deniedWrite(join(directory, 'config')),
    caPrivateKeyReadDenied: deniedRead(resolve('artifacts/acl-offline-ca/ca.key')),
    unrelatedReadDenied: deniedRead(resolve('artifacts/acl-unrelated-private/sentinel.txt')),
    unrelatedWriteDenied: deniedWrite(resolve('artifacts/acl-unrelated-private')),
    otherWindowsIdentityOriginalAccountReadDenied: deniedRead(resolve('server-node/data/accounts.sqlite')),
    dataWritable: !deniedWrite(join(directory, 'data')), logsWritable: !deniedWrite(join(directory, 'logs')), tempWritable: !deniedWrite(join(directory, 'temp'))
  };
  assert.ok(Object.values(boundaries).every(Boolean));
  assert.equal(readdirSync(directory, { recursive: true }).some(name => /(^|[\\/])ca\.key$/i.test(name)), false);
  const isAdministrator = execFileSync('powershell.exe', ['-NoProfile', '-Command', '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)'], { encoding: 'utf8', windowsHide: true }).trim();
  assert.equal(isAdministrator, 'False');
  const result = { identity: execFileSync('whoami', [], { encoding: 'utf8', windowsHide: true }).trim(), health: status, ...boundaries,
    node: process.version, isAdministrator: false, caPrivateKeyAbsentFromRuntime: true, databaseWritable: true, verifiedStorageAcl: true };
  console.log(JSON.stringify(result)); writeFileSync('artifacts/baseline/acl-runtime.json', JSON.stringify(result, null, 2));
} finally { await service.stop(); }
