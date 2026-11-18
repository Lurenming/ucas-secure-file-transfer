import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, lstatSync, existsSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, join, parse } from 'node:path';
import { fileURLToPath } from 'node:url';

export const defaultDataDirectory = fileURLToPath(new URL('../data/', import.meta.url));

// ASCII only, 3..32 characters, first character a letter; case-insensitive, no trim.
export function normalizeUsername(value) {
  if (typeof value !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{2,31}$/.test(value)) {
    throw new Error('用户名须为 3–32 个 ASCII 字母、数字或下划线，以字母开头；不允许空白。');
  }
  return value.toLowerCase();
}

export function openAccounts(directory = process.env.SFT_DATA_DIR || defaultDataDirectory) {
  const base = resolve(directory);
  if (base === parse(base).root || base === resolve(fileURLToPath(new URL('../', import.meta.url)))) {
    throw new Error('Account storage requires a dedicated data directory.');
  }
  mkdirSync(base, { recursive: true, mode: 0o700 });
  if (lstatSync(base).isSymbolicLink()) throw new Error('Data directory must not be a symbolic link.');
  if (process.platform === 'win32') {
    const identity = execFileSync('whoami', [], { encoding: 'utf8', windowsHide: true }).trim();
    execFileSync('icacls.exe', [base, '/inheritance:r', '/grant:r', `${identity}:(OI)(CI)F`], { stdio: 'pipe', windowsHide: true });
  } else chmodSync(base, 0o700);
  const filename = join(base, 'accounts.sqlite');
  if (existsSync(filename) && lstatSync(filename).isSymbolicLink()) throw new Error('Database must not be a symbolic link.');
  const db = new DatabaseSync(filename);
  try {
    // Experimental synchronous API: only bounded indexed queries; never password work here.
    db.exec(`PRAGMA busy_timeout=100; PRAGMA journal_mode=WAL; PRAGMA trusted_schema=OFF;
      CREATE TABLE IF NOT EXISTS users (
        user_id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE COLLATE BINARY,
        password_hash BLOB NOT NULL,
        salt BLOB NOT NULL,
        algorithm TEXT NOT NULL,
        n INTEGER NOT NULL, r INTEGER NOT NULL, p INTEGER NOT NULL,
        key_length INTEGER NOT NULL, maxmem INTEGER NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;`);
    if (process.platform !== 'win32') chmodSync(filename, 0o600);
    const find = db.prepare('SELECT user_id, username, password_hash, salt, algorithm, n, r, p, key_length, maxmem, created_at FROM users WHERE username = ?');
    const insert = db.prepare('INSERT INTO users (user_id, username, password_hash, salt, algorithm, n, r, p, key_length, maxmem, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    let closed = false;
    return {
      filename,
      findByUsername: (username) => find.get(username),
      insert: (record) => {
        const username = normalizeUsername(record.username);
        try {
          insert.run(record.userId, username, record.hash, record.salt, record.algorithm,
            record.N, record.r, record.p, record.keyLength, record.maxmem, record.createdAt);
        } catch (error) {
          if (error.errcode === 2067 || error.errcode === 1555) throw new Error('用户名已存在，未修改已有账户。');
          throw new Error('账户写入失败。');
        }
      },
      close: () => { if (!closed) { closed = true; db.close(); } },
    };
  } catch (error) { db.close(); throw error; }
}
