import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { openAccounts } from '../src/accounts.js';

export function temporaryAccounts() {
  const directory = mkdtempSync(join(tmpdir(), 'sft-p1-'));
  const store = openAccounts(join(directory, 'data'));
  return { directory, store, cleanup() {
    store.close();
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('sft-p1-')) throw new Error('Unexpected test directory');
    rmSync(directory, { recursive: true, force: true });
  } };
}
