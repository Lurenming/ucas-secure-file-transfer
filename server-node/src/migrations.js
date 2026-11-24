// Additive, transactional, versioned migrations. Run only after taking an offline backup.
export function migrate(db, kind) {
  const version = db.prepare('PRAGMA user_version').get().user_version;
  if (version > 1) throw new Error('Database schema is newer than this server');
  if (version === 1) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    if (kind === 'accounts') db.exec(`
      CREATE TABLE account_policy (
        user_id TEXT PRIMARY KEY REFERENCES users(user_id),
        tier TEXT NOT NULL CHECK(tier IN ('ordinary','vip')),
        upload_bps INTEGER NOT NULL CHECK(upload_bps BETWEEN 8192 AND 104857600),
        download_bps INTEGER NOT NULL CHECK(download_bps BETWEEN 8192 AND 104857600)
      ) STRICT;
      CREATE TABLE client_certificates (
        fingerprint TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(user_id),
        disabled INTEGER NOT NULL DEFAULT 0 CHECK(disabled IN (0,1)),
        not_after TEXT NOT NULL, registered_at TEXT NOT NULL
      ) STRICT;`);
    else if (kind === 'uploads') db.exec(`
      ALTER TABLE files ADD COLUMN resume_sha256 TEXT;
      ALTER TABLE files ADD COLUMN durable_offset INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE files ADD COLUMN retain_until INTEGER;
      CREATE INDEX files_retention ON files(state,retain_until);`);
    else throw new Error('Unknown database kind');
    db.exec('PRAGMA user_version=1; COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
