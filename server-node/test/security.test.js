import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { openAccounts } from '../src/accounts.js';
import { fixture, logged, upload, until } from './upload-fixture.js';

function acl(path) {
  const script = `$ProgressPreference='SilentlyContinue'; $a=Get-Acl -LiteralPath $env:SFT_TEST_ACL_PATH; @($a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | ForEach-Object { [pscustomobject]@{sid=$_.IdentityReference.Value;type=$_.AccessControlType.ToString();inheritance=[int]$_.InheritanceFlags;propagation=[int]$_.PropagationFlags} }) | ConvertTo-Json -Compress`;
  const raw = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { env: { ...process.env, SFT_TEST_ACL_PATH: path }, windowsHide: true, encoding: 'utf8' });
  const value = JSON.parse(raw); return Array.isArray(value) ? value : [value];
}

test('P4: existing dedicated account directory does not retain an explicit Everyone read grant', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t), directory = dirname(f.accounts.store.filename);
  // This fixture owns this temporary directory. Never change a real account store or repository ACL.
  execFileSync('icacls.exe', [directory, '/grant', '*S-1-1-0:(OI)(CI)R'], { windowsHide: true, stdio: 'pipe' });
  execFileSync('icacls.exe', [f.accounts.store.filename, '/grant', '*S-1-1-0:R'], { windowsHide: true, stdio: 'pipe' });
  assert.ok(acl(directory).some(x => x.sid === 'S-1-1-0' && x.type === 'Allow'));
  const reopened = openAccounts(directory);
  try {
    assert.ok(!acl(directory).some(x => x.sid === 'S-1-1-0' && x.type === 'Allow'));
    assert.ok(!acl(f.accounts.store.filename).some(x => x.sid === 'S-1-1-0' && x.type === 'Allow'));
    assert.ok(reopened.findByUsername('alice'));
  } finally { reopened.close(); }
  const noInheritance = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;
    $a=New-Object Security.AccessControl.DirectorySecurity; $a.SetAccessRuleProtection($true,$false);
    $a.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','None','None','Allow')));
    (New-Object IO.DirectoryInfo($env:SFT_TEST_ACL_PATH)).SetAccessControl($a);`;
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(noInheritance, 'utf16le').toString('base64')],
    { env: { ...process.env, SFT_TEST_ACL_PATH: directory }, windowsHide: true, stdio: 'pipe' });
  assert.equal(acl(directory)[0].inheritance, 0);
  const inherited = openAccounts(directory);
  try {
    const rules = acl(directory);
    assert.equal(rules.length, 1); assert.equal(rules[0].inheritance, 3); assert.equal(rules[0].propagation, 0);
    const probe = directory + '/p4-created-child.txt';
    await writeFile(probe, 'permission inheritance probe', { flag: 'wx' });
    const childRules = acl(probe);
    assert.equal(childRules.length, 1); assert.equal(childRules[0].sid, rules[0].sid);
    assert.ok(inherited.findByUsername('alice'));
  } finally { inherited.close(); }
});

test('P4: failed exclusive temporary create never deletes a file the upload did not create', async t => {
  const f = await fixture(t), p = await logged(f), originalCreate = f.uploadStore.create.bind(f.uploadStore);
  let collision;
  f.uploadStore.create = async item => {
    collision = item.paths.part;
    await writeFile(collision, 'unrelated collision content', { flag: 'wx' });
    return originalCreate(item);
  };
  assert.equal((await p.request('UPLOAD_BEGIN', { name: 'collision.bin', size: 1 })).code, 'UPLOAD_STORAGE_ERROR');
  await until(() => f.uploadStore.active.size === 0);
  assert.equal(await readFile(collision, 'utf8'), 'unrelated collision content');
  assert.equal(f.uploadStore.count, 0); assert.equal(f.uploadStore.used, 0);
  f.uploadStore.create = originalCreate;
  await upload(p, Buffer.from('works after rejected collision'));
});

test('P4: bounded simulated JSON/binary send backlog closes and releases transfers', async t => {
  const f = await fixture(t);
  for (const binary of [false, true]) {
    const p = await logged(f);
    let downloadId;
    if (binary) { const file = await upload(p, Buffer.from('x')); downloadId = (await p.request('DOWNLOAD_BEGIN', { fileId: file.fileId })).data.downloadId; }
    const ws = [...f.wss.clients].at(-1);
    Object.defineProperty(ws, 'bufferedAmount', { configurable: true, get: () => 64 * 1024 });
    // One frame only; deterministic backpressure injection, no real flood or memory exhaustion.
    p.ws.send(JSON.stringify({ version: 1, type: binary ? 'DOWNLOAD_CHUNK' : 'ECHO', requestId: randomUUID(),
      data: binary ? { downloadId, offset: 0 } : { text: 'bounded check' } }));
    assert.equal(await p.closed, 1013); await until(() => f.uploadStore.active.size === 0 && f.wss.clients.size === 0);
  }
});

test('P4: committed zero-byte records still consume the bounded file-count quota', async t => {
  const f = await fixture(t, { uploadOptions: { policy: { maxFiles: 2, quotaBytes: 16 } } }), p = await logged(f);
  await upload(p, Buffer.alloc(0)); await upload(p, Buffer.alloc(0));
  assert.equal((await p.request('UPLOAD_BEGIN', { name: 'third', size: 0 })).code, 'UPLOAD_QUOTA');
  assert.equal(f.uploadStore.count, 2); assert.equal(f.uploadStore.used, 0);
  assert.equal((await p.request('AUTH_ME')).data.userId, p.identity.userId);
});
