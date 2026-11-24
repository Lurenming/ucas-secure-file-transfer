import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, lstatSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from 'node:fs';
import { open, link, unlink } from 'node:fs/promises';
import { resolve, join, parse } from 'node:path';
import { randomUUID, randomBytes } from 'node:crypto';
import { canonicalUuid } from './upload-protocol.js';
import { restrictPrivatePath as restrictDirectory } from './private-storage.js';
import { migrate } from './migrations.js';
import { resumeMethods } from './resume-store.js';

const marker = 'SecureFileTransfer.UploadStore.v1\n';
export const uploadPolicy = Object.freeze({ maxFileBytes: 100 * 1024 * 1024, maxActive: 16,
  quotaBytes: 1024 * 1024 * 1024, maxFiles: 1000, idleMs: 120000, totalMs: 24 * 60 * 60 * 1000, retentionMs: 24 * 60 * 60 * 1000 });

function regular(path) {
  if (!existsSync(path)) return null;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Unsafe upload storage entry');
  return stat;
}
function sameFile(a, b) { return a && b && a.dev === b.dev && a.ino === b.ino; }

export class UploadStore {
  constructor(directory, policy = {}, hooks = {}) {
    this.directory = resolve(directory); this.policy = { ...uploadPolicy, ...policy }; this.hooks = hooks;
    if (this.directory === parse(this.directory).root) throw new Error('Dedicated upload directory required');
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (lstatSync(this.directory).isSymbolicLink()) throw new Error('Upload directory must not be a link');
    const markerPath = join(this.directory, '.sft-uploads');
    if (!existsSync(markerPath)) {
      if (readdirSync(this.directory).length) throw new Error('Refusing unmarked upload directory');
      writeFileSync(markerPath, marker, { flag: 'wx', mode: 0o600 });
    } else if (!regular(markerPath) || readFileSync(markerPath, 'utf8') !== marker) throw new Error('Invalid upload ownership marker');
    restrictDirectory(this.directory);
    this.lockPath = join(this.directory, 'writer.lock');
    if (existsSync(this.lockPath)) {
      regular(this.lockPath);
      const pid = Number(readFileSync(this.lockPath, 'utf8'));
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid upload writer lock; inspect manually');
      try { process.kill(pid, 0); throw new Error('Upload directory already has a live writer'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
      unlinkSync(this.lockPath); // Stale lock belonging to this marked application store only.
    }
    writeFileSync(this.lockPath, String(process.pid), { flag: 'wx', mode: 0o600 });
    try {
      this.objects = join(this.directory, 'objects');
      mkdirSync(this.objects, { mode: 0o700 });
    } catch (error) {
      if (error.code !== 'EEXIST') { unlinkSync(this.lockPath); throw error; }
    }
    try {
      if (lstatSync(this.objects).isSymbolicLink() || !lstatSync(this.objects).isDirectory()) throw new Error('Unsafe objects directory');
      restrictDirectory(this.objects);
      const dbPath = join(this.directory, 'uploads.sqlite');
      for (const knownFile of [dbPath, dbPath + '-wal', dbPath + '-shm'])
        if (existsSync(knownFile)) restrictDirectory(knownFile, false);
      this.db = new DatabaseSync(dbPath);
      this.db.exec(`PRAGMA busy_timeout=100; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS files (
          file_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, connection_id TEXT NOT NULL, auth_generation INTEGER NOT NULL,
          display_name TEXT NOT NULL, size INTEGER NOT NULL CHECK(size >= 0), sha256 TEXT,
          state TEXT NOT NULL CHECK(state IN ('receiving','committing','committed')),
          created_at TEXT NOT NULL, committed_at TEXT
        ) STRICT;
        CREATE INDEX IF NOT EXISTS files_owner_page ON files(owner_id, state, committed_at DESC, file_id DESC);`);
      migrate(this.db, 'uploads');
      this.insert = this.db.prepare('INSERT INTO files (file_id,owner_id,connection_id,auth_generation,display_name,size,state,created_at) VALUES (?,?,?,?,?,?,?,?)');
      this.remove = this.db.prepare('DELETE FROM files WHERE file_id = ? AND state != ?');
      this.precommit = this.db.prepare('UPDATE files SET state = ?, sha256 = ? WHERE file_id = ? AND state = ?');
      this.commit = this.db.prepare('UPDATE files SET state = ?, committed_at = ? WHERE file_id = ? AND state = ?');
      this.find = this.db.prepare('SELECT * FROM files WHERE file_id = ?');
      this.list = this.db.prepare('SELECT * FROM files ORDER BY created_at, file_id');
      this.owned = this.db.prepare('SELECT * FROM files WHERE file_id = ? AND owner_id = ? AND state = ?');
      this.pageFirst = this.db.prepare('SELECT * FROM files WHERE owner_id = ? AND state = ? ORDER BY committed_at DESC, file_id DESC LIMIT ?');
      this.pageAfter = this.db.prepare('SELECT * FROM files WHERE owner_id = ? AND state = ? AND (committed_at < ? OR (committed_at = ? AND file_id < ?)) ORDER BY committed_at DESC, file_id DESC LIMIT ?');
      this.cursorKey = randomBytes(32); // Bounded stateless cursors, authenticated and bound to the current user.
      this.recover();
      const totals = this.db.prepare('SELECT COALESCE(SUM(size),0) AS bytes, COUNT(*) AS count FROM files').get();
      this.used = totals.bytes; this.count = totals.count; this.active = new Set();
    } catch (error) { this.db?.close(); unlinkSync(this.lockPath); throw error; }
  }
  paths(id) {
    if (!canonicalUuid.test(id)) throw new Error('Invalid stored upload ID');
    return { part: join(this.objects, `${id}.part`), final: join(this.objects, `${id}.bin`) };
  }
  recover() {
    // Startup only, before listening. Never enumerate/delete unrecorded user files.
    for (const row of this.list.all()) {
      const paths = this.paths(row.file_id), part = regular(paths.part), final = regular(paths.final);
      if (row.state === 'committed') {
        if (!final || final.size !== row.size) throw new Error('Committed file missing or size changed; inspect storage');
        if (part) {
          if (!sameFile(part, final)) throw new Error('Unexpected committed temporary file');
          unlinkSync(paths.part);
        }
      } else if (row.resume_sha256 && row.retain_until > Date.now()) {
        this.recoverResumable(row, paths, part, final);
      } else {
        if (final) {
          if (!sameFile(part, final)) throw new Error('Cannot prove ownership of incomplete published file');
          unlinkSync(paths.final);
        }
        if (part) unlinkSync(paths.part);
        this.remove.run(row.file_id, 'committed');
      }
    }
  }
  reserve(owner, connectionId, generation, name, size) {
    if (this.failed || this.closed) throw new Error('UPLOAD_STORAGE_ERROR');
    if (this.active.size >= this.policy.maxActive) throw new Error('UPLOAD_LIMIT');
    if (this.count >= this.policy.maxFiles || this.used + size > this.policy.quotaBytes) throw new Error('UPLOAD_QUOTA');
    const id = randomUUID(), paths = this.paths(id);
    if (existsSync(paths.part) || existsSync(paths.final)) throw new Error('UPLOAD_STORAGE_ERROR');
    this.insert.run(id, owner, connectionId, generation, name, size, 'receiving', new Date().toISOString());
    this.used += size; this.count++;
    const item = { id, paths, owner, connectionId, generation, name, size, received: 0, valid: true, committed: false, abort: new AbortController() };
    this.active.add(item);
    return item;
  }
  async create(item) {
    item.handle = await open(item.paths.part, 'wx', 0o600);
    item.created = true; // A reservation alone does not prove this process created the file.
  }
  reserveDownload(owner, connectionId, generation, file) {
    if (this.closed || this.failed) throw new Error('FILE_UNAVAILABLE');
    if (this.active.size >= this.policy.maxActive) throw new Error('TRANSFER_LIMIT');
    const item = { id: randomUUID(), owner, connectionId, generation, file, sent: 0, valid: true, kind: 'download', abort: new AbortController() };
    this.active.add(item); // The same budget as uploads; no second global pool.
    return item;
  }
  async write(item, data) {
    await this.hooks.beforeWrite?.(item);
    let offset = 0;
    while (offset < data.length) {
      if (!item.valid) throw new Error('UPLOAD_CANCELLED');
      const length = Math.min(data.length - offset, this.hooks.maxWriteBytes ?? data.length);
      const { bytesWritten } = await item.handle.write(data, offset, length, item.received + offset);
      if (bytesWritten <= 0) throw new Error('UPLOAD_STORAGE_ERROR');
      offset += bytesWritten;
    }
  }
  async publish(item, digest, check) {
    await item.handle.sync(); check();
    await item.handle.close(); item.handle = null; check();
    await this.hooks.beforePreparing?.(item); check();
    if (this.precommit.run('committing', digest, item.id, 'receiving').changes !== 1) throw new Error('UPLOAD_STORAGE_ERROR');
    await this.hooks.afterPreparing?.(item); check();
    await link(item.paths.part, item.paths.final); item.linked = true; check(); // Exclusive final name, no overwrite.
    await this.hooks.beforeCommit?.(item); check();
    if (this.commit.run('committed', new Date().toISOString(), item.id, 'committing').changes !== 1) throw new Error('UPLOAD_STORAGE_ERROR');
    item.committed = true; // No awaits between the last validity check and this durable decision.
    try {
      await this.hooks.afterCommit?.(item);
      try { await unlink(item.paths.part); } catch { /* Startup removes this recorded temporary link. */ }
    } finally { this.active.delete(item); }
  }
  async discard(item) {
    if (item.committed) return; // ACK loss/cancellation after commit must never delete committed content.
    try {
      await item.handle?.close(); item.handle = null;
      if (item.linked) await unlink(item.paths.final);
      if (item.created) {
        try { await unlink(item.paths.part); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      this.remove.run(item.id, 'committed');
      this.used -= item.size; this.count--; this.active.delete(item);
    } catch { this.failed = true; throw new Error('UPLOAD_STORAGE_ERROR'); } // Keep reservation; recover on restart.
  }
  close() {
    if (this.closed) return;
    this.closed = true; this.db.close(); unlinkSync(this.lockPath);
  }
}
Object.assign(UploadStore.prototype, resumeMethods);
