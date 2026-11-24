import { open, unlink } from 'node:fs/promises';
import { lstatSync, truncateSync, unlinkSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';

export const resumeMethods = {
  markResumable(item, sha256) {
    item.resumable = true; item.expectedHash = sha256;
    this.db.prepare('UPDATE files SET resume_sha256=?,retain_until=? WHERE file_id=?').run(sha256, Date.now() + this.policy.retentionMs, item.id);
  },
  recoverResumable(row, paths, part, final) {
    if (!part) {
      if (row.durable_offset !== 0 || final) throw new Error('Missing durable upload data; manual recovery required');
      this.remove.run(row.file_id, 'committed'); return;
    }
    if (part.size < row.durable_offset || row.durable_offset > row.size) throw new Error('Durable upload shorter than database checkpoint');
    if (final) {
      if (part.ino !== final.ino || part.dev !== final.dev) throw new Error('Unrelated final object');
      unlinkSync(paths.final);
    }
    if (part.size > row.durable_offset) truncateSync(paths.part, row.durable_offset);
    this.db.prepare("UPDATE files SET state='receiving',sha256=NULL WHERE file_id=?").run(row.file_id);
  },
  resumeRow(owner, id) {
    const row = this.find.get(id);
    if (!row || row.owner_id !== owner || !row.resume_sha256) throw new Error('UPLOAD_NOT_FOUND');
    if (row.state !== 'committed' && row.retain_until <= Date.now()) throw new Error('UPLOAD_EXPIRED');
    return row;
  },
  claim(owner, connectionId, generation, row) {
    if (this.failed || this.closed) throw new Error('UPLOAD_STORAGE_ERROR');
    if ([...this.active].some(item => item.id === row.file_id)) throw new Error('UPLOAD_BUSY');
    if (this.active.size >= this.policy.maxActive) throw new Error('UPLOAD_LIMIT');
    const item = { id: row.file_id, paths: this.paths(row.file_id), owner, connectionId, generation,
      name: row.display_name, size: row.size, received: row.durable_offset, resumable: true,
      expectedHash: row.resume_sha256, valid: true, committed: false, created: true, abort: new AbortController() };
    this.active.add(item);
    this.db.prepare('UPDATE files SET connection_id=?,auth_generation=? WHERE file_id=?').run(connectionId, generation, item.id);
    return item;
  },
  async openResume(item, check) {
    const before = lstatSync(item.paths.part);
    if (!before.isFile() || before.isSymbolicLink() || before.size < item.received) throw new Error('UPLOAD_STORAGE_ERROR');
    item.handle = await open(item.paths.part, 'r+'); check();
    const after = await item.handle.stat(); check();
    if (before.ino !== after.ino || before.dev !== after.dev) throw new Error('UPLOAD_STORAGE_ERROR');
    await item.handle.truncate(item.received); check();
    item.hash = createHash('sha256');
    const buffer = Buffer.alloc(65536);
    for (let at = 0; at < item.received;) {
      const { bytesRead } = await item.handle.read(buffer, 0, Math.min(buffer.length, item.received - at), at); check();
      if (!bytesRead) throw new Error('UPLOAD_STORAGE_ERROR');
      item.hash.update(buffer.subarray(0, bytesRead)); at += bytesRead;
    }
  },
  async checkpoint(item) {
    if (!item.resumable) return;
    await item.handle.sync();
    this.db.prepare('UPDATE files SET durable_offset=? WHERE file_id=? AND state=?').run(item.received, item.id, 'receiving');
  },
  async retain(item) {
    if (item.committed) return;
    await item.handle?.close(); item.handle = null;
    if (item.linked) { await unlink(item.paths.final); item.linked = false; }
    this.db.prepare("UPDATE files SET state='receiving',sha256=NULL WHERE file_id=? AND state='committing'").run(item.id);
    // Only fully checkpointed bytes may be advertised after reconnect/restart.
    this.active.delete(item);
  },
  sweep() {
    for (const row of this.db.prepare("SELECT * FROM files WHERE state!='committed' AND retain_until<=? LIMIT 1000").all(Date.now())) {
      if ([...this.active].some(item => item.id === row.file_id)) continue;
      const paths = this.paths(row.file_id);
      if (existsSync(paths.final)) continue; // Ambiguous commit is handled at startup, never delete arbitrary files.
      if (existsSync(paths.part)) {
        const stat = lstatSync(paths.part); if (!stat.isFile() || stat.isSymbolicLink()) continue;
        unlinkSync(paths.part);
      }
      this.remove.run(row.file_id, 'committed'); this.used -= row.size; this.count--;
    }
  }
};
