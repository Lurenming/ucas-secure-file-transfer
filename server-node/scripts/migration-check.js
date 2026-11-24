import { openAccounts } from '../src/accounts.js';
import { UploadStore } from '../src/upload-store.js';
import { DatabaseSync } from 'node:sqlite';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const directory = resolve(process.argv[2]);
if (!directory.includes('artifacts') || !directory.includes('migration-copy')) throw new Error('Use an isolated migration-copy only');
const beforeAccount = new DatabaseSync(join(directory, 'accounts.sqlite'), { readOnly: true });
const users = beforeAccount.prepare('SELECT user_id,username,password_hash,salt FROM users ORDER BY user_id').all(); beforeAccount.close();
const beforeFiles = new DatabaseSync(join(directory, 'uploads/uploads.sqlite'), { readOnly: true });
const files = beforeFiles.prepare("SELECT file_id,owner_id,size,sha256 FROM files WHERE state='committed' ORDER BY file_id").all(); beforeFiles.close();
const accounts = openAccounts(directory), uploads = new UploadStore(join(directory, 'uploads'));
assert.deepEqual(accounts.db.prepare('SELECT user_id,username,password_hash,salt FROM users ORDER BY user_id').all(), users);
assert.deepEqual(uploads.db.prepare("SELECT file_id,owner_id,size,sha256 FROM files WHERE state='committed' ORDER BY file_id").all(), files);
for (const row of files) {
  const data = readFileSync(uploads.paths(row.file_id).final); assert.equal(data.length, row.size);
  assert.equal(createHash('sha256').update(data).digest('hex'), row.sha256);
}
console.log(JSON.stringify({ accountSchema: accounts.db.prepare('PRAGMA user_version').get().user_version,
  uploadSchema: uploads.db.prepare('PRAGMA user_version').get().user_version, preservedUsers: users.length, preservedCommittedFiles: files.length,
  accountsIntegrity: accounts.db.prepare('PRAGMA integrity_check').get(), uploadsIntegrity: uploads.db.prepare('PRAGMA integrity_check').get() }));
uploads.close(); accounts.close();
