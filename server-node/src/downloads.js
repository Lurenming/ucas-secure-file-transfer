import { open, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { chunkBytes, validUploadId } from './upload-protocol.js';
import { encodeDownloadChunk } from './download-protocol.js';
import { fileListReply, publicFile } from './file-list.js';

const errors = new Set(['AUTH_REQUIRED', 'INVALID_MESSAGE', 'INVALID_CURSOR', 'FILE_RATE_LIMITED', 'FILE_NOT_FOUND',
  'FILE_UNAVAILABLE', 'TRANSFER_BUSY', 'TRANSFER_LIMIT', 'DOWNLOAD_NOT_FOUND', 'DOWNLOAD_OFFSET', 'DOWNLOAD_CANCELLED']);

export class ConnectionDownloads {
  constructor(store, auth, connectionId, send, sendBinary, close, otherActive) {
    Object.assign(this, { store, auth, connectionId, send, sendBinary, close, otherActive });
    this.item = null; this.busy = false; this.disposed = false; this.listTokens = 5; this.listUpdated = performance.now();
  }
  error(requestId, code) {
    this.send({ type: 'ERROR', requestId, code: errors.has(code) ? code : 'FILE_UNAVAILABLE', message: '文件请求未完成。' });
  }
  identity() {
    const identity = this.auth.snapshot();
    if (!identity || this.disposed) throw new Error('AUTH_REQUIRED');
    return identity;
  }
  check(item) {
    const identity = this.identity();
    if (!item.valid || this.item !== item || identity.userId !== item.owner || identity.generation !== item.generation
      || item.connectionId !== this.connectionId) throw new Error('DOWNLOAD_CANCELLED');
  }
  clearTimers(item) { clearTimeout(item.idleTimer); clearTimeout(item.totalTimer); }
  touch(item) {
    clearTimeout(item.idleTimer);
    item.idleTimer = setTimeout(() => this.invalidate(true), this.store.policy.idleMs); item.idleTimer.unref();
  }
  invalidate(notify = false) {
    const item = this.item;
    if (!item) return Promise.resolve();
    item.valid = false; item.abort.abort(); this.clearTimers(item);
    if (notify) this.send({ type: 'DOWNLOAD_ABORTED', data: { downloadId: item.id, code: 'DOWNLOAD_CANCELLED' } });
    if (!item.cleanup) item.cleanup = (async () => {
      await item.job;
      await item.handle?.close(); item.handle = null;
      this.store.active.delete(item);
      if (this.item === item) this.item = null;
    })().catch(() => { this.store.failed = true; }); // Retain budget if a handle could not be closed.
    return item.cleanup;
  }
  run(item, requestId, operation) {
    this.busy = true;
    item.job = (async () => {
      try { await operation(); }
      catch (error) { item.valid = false; this.clearTimers(item); this.error(requestId, error.message); }
      finally { this.busy = false; }
    })();
    void item.job.then(() => { if (!item.valid) void this.invalidate(); });
  }
  async sizeCheck(item) {
    const stat = await item.handle.stat(); this.check(item);
    if (!stat.isFile() || stat.size !== item.file.size) throw new Error('FILE_UNAVAILABLE');
  }
  handle({ type, requestId, data }) {
    try {
      const identity = this.identity();
      if (type === 'FILES_LIST') {
        const now = performance.now(); this.listTokens = Math.min(5, this.listTokens + (now - this.listUpdated) / 200); this.listUpdated = now;
        if (this.listTokens < 1) throw new Error('FILE_RATE_LIMITED');
        this.listTokens--;
        const reply = fileListReply(this.store, identity.userId, data, this.connectionId, requestId);
        if (this.identity().generation !== identity.generation) throw new Error('AUTH_REQUIRED');
        this.send(reply); return;
      }
      if (type === 'DOWNLOAD_CANCEL') {
        if (this.cancelling) throw new Error('TRANSFER_BUSY');
        if (data.downloadId !== undefined && !validUploadId(data.downloadId)) throw new Error('INVALID_MESSAGE');
        if (data.downloadId && data.downloadId !== this.item?.id) throw new Error('DOWNLOAD_NOT_FOUND');
        const id = this.item?.id ?? data.downloadId ?? null;
        this.cancelling = true;
        void this.invalidate().then(() => {
          if (this.store.failed) this.error(requestId, 'FILE_UNAVAILABLE');
          else this.send({ type: 'DOWNLOAD_CANCEL_RESULT', requestId, data: { downloadId: id } });
        }).finally(() => { this.cancelling = false; }); return;
      }
      if (this.busy || this.cancelling) {
        if (type === 'DOWNLOAD_CHUNK') { void this.invalidate(); this.close(1008, 'Wait for download response'); return; }
        throw new Error('TRANSFER_BUSY');
      }
      if (type === 'DOWNLOAD_BEGIN' || type === 'DOWNLOAD_OPEN') {
        if (this.item || this.otherActive()) throw new Error('TRANSFER_BUSY');
        if (!validUploadId(data.fileId)) throw new Error('INVALID_MESSAGE');
        const row = this.store.owned.get(data.fileId, identity.userId, 'committed');
        if (!row) throw new Error('FILE_NOT_FOUND'); // Same reply for missing and other-owner IDs, before any file IO.
        const offset = type === 'DOWNLOAD_OPEN' ? data.offset : 0;
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > row.size) throw new Error('DOWNLOAD_OFFSET');
        if (type === 'DOWNLOAD_OPEN' && (data.sha256 !== row.sha256 || data.size !== row.size || !/^[a-f0-9]{64}$/.test(data.prefixSha256))) throw new Error('DOWNLOAD_OFFSET');
        const file = publicFile(row), item = this.store.reserveDownload(identity.userId, this.connectionId, identity.generation, file);
        this.item = item; item.hash = createHash('sha256'); this.touch(item);
        item.totalTimer = setTimeout(() => this.invalidate(true), this.store.policy.totalMs); item.totalTimer.unref();
        this.run(item, requestId, async () => {
          const path = this.store.paths(file.fileId).final;
          const before = await lstat(path); this.check(item);
          if (!before.isFile() || before.isSymbolicLink() || before.size !== file.size) throw new Error('FILE_UNAVAILABLE');
          item.handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); this.check(item);
          const after = await item.handle.stat(); this.check(item);
          if (before.dev !== after.dev || before.ino !== after.ino || !after.isFile() || after.size !== file.size) throw new Error('FILE_UNAVAILABLE');
          if (type === 'DOWNLOAD_OPEN') {
            const prefix = Buffer.alloc(65536);
            for (let at = 0; at < offset;) {
              const { bytesRead } = await item.handle.read(prefix, 0, Math.min(prefix.length, offset - at), at); this.check(item);
              if (!bytesRead) throw new Error('FILE_UNAVAILABLE');
              item.hash.update(prefix.subarray(0, bytesRead)); at += bytesRead;
            }
            if (item.hash.copy().digest('hex') !== data.prefixSha256) throw new Error('DOWNLOAD_OFFSET');
          }
          item.sent = offset;
          this.send({ type: type + '_RESULT', requestId, data: { downloadId: item.id, ...file, offset, chunkBytes } });
        }); return;
      }
      const item = this.item;
      if (!validUploadId(data.downloadId)) throw new Error('INVALID_MESSAGE');
      if (!item || item.id !== data.downloadId) throw new Error('DOWNLOAD_NOT_FOUND');
      this.check(item);
      if (type === 'DOWNLOAD_CHUNK') {
        if (!validUploadId(requestId) || !Number.isSafeInteger(data.offset) || data.offset < 0) throw new Error('INVALID_MESSAGE');
        if (data.offset !== item.sent || item.sent >= item.file.size) throw new Error('DOWNLOAD_OFFSET');
        this.run(item, requestId, async () => {
          await this.store.bandwidth?.take(item.owner, 'download', Math.min(chunkBytes, item.file.size - item.sent), item.abort.signal); this.check(item);
          await this.store.hooks.beforeRead?.(item); this.check(item);
          await this.sizeCheck(item);
          const bytes = Buffer.alloc(Math.min(chunkBytes, item.file.size - item.sent));
          let count = 0;
          while (count < bytes.length) {
            const result = await item.handle.read(bytes, count, Math.min(bytes.length - count, this.store.hooks.maxReadBytes ?? bytes.length), item.sent + count);
            this.check(item);
            if (result.bytesRead <= 0) throw new Error('FILE_UNAVAILABLE');
            count += result.bytesRead;
          }
          await this.sizeCheck(item);
          const frame = encodeDownloadChunk(requestId, item.id, item.sent, bytes);
          item.hash.update(bytes); item.sent += bytes.length;
          await this.sendBinary(frame, () => this.check(item)); this.check(item); this.touch(item);
        });
      } else if (type === 'DOWNLOAD_COMPLETE') {
        this.run(item, requestId, async () => {
          if (item.sent !== item.file.size) throw new Error('DOWNLOAD_OFFSET');
          await this.sizeCheck(item);
          if (item.hash.digest('hex') !== item.file.sha256) throw new Error('FILE_UNAVAILABLE');
          await item.handle.close(); item.handle = null; this.check(item);
          this.clearTimers(item); this.store.active.delete(item); this.item = null;
          this.send({ type: 'DOWNLOAD_COMPLETE_RESULT', requestId,
            data: { downloadId: item.id, fileId: item.file.fileId, size: item.file.size, sha256: item.file.sha256 } });
        });
      }
    } catch (error) { this.error(requestId, error.message); }
  }
  dispose() { this.disposed = true; return this.invalidate(); }
}
