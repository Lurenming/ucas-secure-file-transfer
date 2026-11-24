import { createHash } from 'node:crypto';
import { chunkBytes, decodeChunk, validUploadId, validDisplayName } from './upload-protocol.js';

const codes = new Set(['AUTH_REQUIRED', 'UPLOAD_BUSY', 'UPLOAD_LIMIT', 'UPLOAD_QUOTA', 'UPLOAD_NOT_FOUND',
  'UPLOAD_CANCELLED', 'UPLOAD_SIZE', 'UPLOAD_HASH', 'UPLOAD_OFFSET', 'UPLOAD_STORAGE_ERROR', 'INVALID_MESSAGE', 'UPLOAD_ALREADY_COMMITTED', 'TRANSFER_BUSY', 'UPLOAD_EXPIRED']);

// One in-flight disk operation per connection; excess blocks are closed, never queued.
export class ConnectionUploads {
  constructor(store, auth, connectionId, send, close) {
    Object.assign(this, { store, auth, connectionId, send, close });
    this.item = null; this.busy = false; this.disposed = false;
  }
  error(requestId, code) { this.send({ type: 'ERROR', requestId, code: codes.has(code) ? code : 'UPLOAD_STORAGE_ERROR', message: '上传请求未完成，请检查状态后重试。' }); }
  identity() {
    const snapshot = this.auth.snapshot();
    if (!snapshot || this.disposed) throw new Error('AUTH_REQUIRED');
    return snapshot;
  }
  check(item) {
    const identity = this.identity();
    if (!item.valid || this.item !== item || identity.userId !== item.owner || identity.generation !== item.generation
      || this.connectionId !== item.connectionId) throw new Error('UPLOAD_CANCELLED');
  }
  touch(item) {
    clearTimeout(item.idleTimer);
    item.idleTimer = setTimeout(() => this.invalidate('UPLOAD_CANCELLED', true), this.store.policy.idleMs);
    item.idleTimer.unref();
  }
  clearTimers(item) { clearTimeout(item.idleTimer); clearTimeout(item.totalTimer); }
  invalidate(code = 'UPLOAD_CANCELLED', notify = false, preserve = true) {
    const item = this.item;
    if (!item) return Promise.resolve();
    item.valid = false; item.abort.abort(); this.clearTimers(item);
    if (notify) this.send({ type: 'UPLOAD_ABORTED', data: { uploadId: item.id, code } });
    if (!item.cleanup) item.cleanup = (async () => {
      await item.job;
      if (item.resumable && preserve && !item.fatal) await this.store.retain(item);
      else await this.store.discard(item);
      if (this.item === item) this.item = null;
    })().catch(() => { this.store.failed = true; });
    return item.cleanup;
  }
  run(item, requestId, operation) {
    this.busy = true;
    item.job = (async () => {
      try { await operation(); }
      catch (error) { item.valid = false; item.fatal = ['UPLOAD_HASH','UPLOAD_SIZE','UPLOAD_STORAGE_ERROR'].includes(error.message); this.clearTimers(item); this.error(requestId, error.message); }
      finally { this.busy = false; }
    })();
    void item.job.then(() => { if (!item.valid && !item.committed) void this.invalidate(); });
  }
  handle(message) {
    const { type, requestId, data } = message;
    try {
      const identity = this.identity();
      if (type === 'UPLOAD_STATUS' || type === 'UPLOAD_FORGET') {
        if (!validUploadId(data.uploadId)) throw new Error('INVALID_MESSAGE');
        const row = this.store.resumeRow(identity.userId, data.uploadId);
        if (type === 'UPLOAD_STATUS') {
          this.send({ type: 'UPLOAD_STATUS_RESULT', requestId, data: { uploadId: row.file_id, state: row.state,
            received: row.durable_offset, size: row.size, sha256: row.resume_sha256, name: row.display_name } }); return;
        }
        if (this.busy || this.cancelling) throw new Error('UPLOAD_BUSY');
        if (row.state === 'committed') throw new Error('UPLOAD_ALREADY_COMMITTED');
        if ([...this.store.active].some(item => item.id === row.file_id)) throw new Error('UPLOAD_BUSY');
        const item = this.store.claim(identity.userId, this.connectionId, identity.generation, row);
        this.busy = true;
        void this.store.discard(item).then(() => this.send({ type: 'UPLOAD_FORGET_RESULT', requestId, data: {} }),
          () => this.error(requestId, 'UPLOAD_STORAGE_ERROR')).finally(() => { this.busy = false; }); return;
      }
      if (type === 'UPLOAD_CANCEL') {
        if (this.cancelling) throw new Error('UPLOAD_BUSY');
        if (data.uploadId !== undefined && !validUploadId(data.uploadId)) throw new Error('INVALID_MESSAGE');
        const item = this.item;
        if (data.uploadId && this.completed === data.uploadId) throw new Error('UPLOAD_ALREADY_COMMITTED');
        if (data.uploadId && item?.id !== data.uploadId) throw new Error('UPLOAD_NOT_FOUND');
        this.cancelling = true;
        const id = item?.id ?? data.uploadId ?? null;
        void this.invalidate('UPLOAD_CANCELLED', false, false).then(() => {
          if (item?.committed) this.error(requestId, 'UPLOAD_ALREADY_COMMITTED');
          else if (this.store.failed) this.error(requestId, 'UPLOAD_STORAGE_ERROR');
          else this.send({ type: 'UPLOAD_CANCEL_RESULT', requestId, data: { uploadId: id } });
        }).finally(() => { this.cancelling = false; });
        return;
      }
      if (this.busy || this.cancelling) throw new Error('UPLOAD_BUSY');
      if (type === 'UPLOAD_PAUSE') {
        if (!this.item?.resumable || data.uploadId !== this.item.id) throw new Error('UPLOAD_NOT_FOUND');
        const id = this.item.id; this.cancelling = true;
        void this.invalidate().then(() => this.send({ type: 'UPLOAD_PAUSE_RESULT', requestId, data: { uploadId: id } }))
          .finally(() => { this.cancelling = false; }); return;
      }
      if (type === 'UPLOAD_RESUME') {
        if (this.item || this.otherActive?.()) throw new Error('TRANSFER_BUSY');
        if (!validUploadId(data.uploadId)) throw new Error('INVALID_MESSAGE');
        const row = this.store.resumeRow(identity.userId, data.uploadId);
        if (data.sha256 !== row.resume_sha256 || data.size !== row.size || data.name !== row.display_name) throw new Error('UPLOAD_HASH');
        if (row.state === 'committed') throw new Error('UPLOAD_ALREADY_COMMITTED');
        const item = this.store.claim(identity.userId, this.connectionId, identity.generation, row); this.item = item;
        this.touch(item);
        this.run(item, requestId, async () => {
          await this.store.openResume(item, () => this.check(item));
          this.send({ type: 'UPLOAD_RESUME_RESULT', requestId, data: { uploadId: item.id, received: item.received, chunkBytes } });
        }); return;
      }
      if (type === 'UPLOAD_BEGIN' || type === 'UPLOAD_OPEN') {
        if (this.otherActive?.()) throw new Error('TRANSFER_BUSY');
        if (this.item) throw new Error('UPLOAD_BUSY');
        if (!validDisplayName(data.name)) throw new Error('INVALID_MESSAGE');
        if (!Number.isSafeInteger(data.size) || data.size < 0 || data.size > this.store.policy.maxFileBytes) throw new Error('UPLOAD_SIZE');
        if (type === 'UPLOAD_OPEN' && (typeof data.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(data.sha256))) throw new Error('INVALID_MESSAGE');
        this.store.sweep();
        const item = this.store.reserve(identity.userId, this.connectionId, identity.generation, data.name, data.size);
        if (type === 'UPLOAD_OPEN') this.store.markResumable(item, data.sha256);
        this.item = item; item.hash = createHash('sha256'); this.touch(item);
        item.totalTimer = setTimeout(() => this.invalidate('UPLOAD_CANCELLED', true), this.store.policy.totalMs);
        item.totalTimer.unref();
        this.run(item, requestId, async () => {
          await this.store.create(item); this.check(item);
          this.send({ type: type + '_RESULT', requestId, data: { uploadId: item.id, received: 0, chunkBytes } });
        });
      } else if (type === 'UPLOAD_COMPLETE') {
        const item = this.item;
        if (!validUploadId(data.uploadId) || typeof data.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(data.sha256)) throw new Error('INVALID_MESSAGE');
        if (!item || data.uploadId !== item.id) throw new Error('UPLOAD_NOT_FOUND');
        this.check(item);
        this.run(item, requestId, async () => {
          if (item.received !== item.size) throw new Error('UPLOAD_SIZE');
          const digest = item.hash.digest('hex');
          if (digest !== data.sha256 || (item.resumable && digest !== item.expectedHash)) throw new Error('UPLOAD_HASH');
          await this.store.publish(item, digest, () => this.check(item));
          this.clearTimers(item); this.completed = item.id; this.item = null;
          // Send failure/late logout cannot roll back a committed file.
          this.send({ type: 'UPLOAD_COMPLETE_RESULT', requestId,
            data: { fileId: item.id, name: item.name, size: item.size, sha256: digest } });
        });
      }
    } catch (error) { this.error(requestId, error.message); }
  }
  binary(raw) {
    let block;
    try { block = decodeChunk(raw); }
    catch { void this.invalidate(); this.close(1003, 'Invalid upload block'); return; }
    try {
      this.identity();
      if (this.busy || this.cancelling) { void this.invalidate(); this.close(1008, 'Wait for upload acknowledgement'); return; }
      const item = this.item;
      if (!item || item.id !== block.uploadId) throw new Error('UPLOAD_NOT_FOUND');
      this.check(item);
      if (block.offset !== item.received) throw new Error('UPLOAD_OFFSET');
      if (block.data.length > item.size - item.received) throw new Error('UPLOAD_SIZE');
      this.run(item, block.requestId, async () => {
        await this.store.bandwidth?.take(item.owner, 'upload', block.data.length, item.abort.signal); this.check(item);
        await this.store.write(item, block.data); this.check(item);
        item.hash.update(block.data); item.received += block.data.length; this.touch(item);
        await this.store.checkpoint(item); this.check(item);
        this.send({ type: 'UPLOAD_CHUNK_RESULT', requestId: block.requestId, data: { uploadId: item.id, received: item.received } });
      });
    } catch (error) { this.error(block.requestId, error.message); }
  }
  dispose() { this.disposed = true; return this.invalidate(); }
}
