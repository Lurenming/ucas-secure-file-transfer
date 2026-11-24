// One FIFO token bucket per ACCOUNT and DIRECTION, shared by every socket/window.
// Only one <=8192-byte pending block per transfer; control traffic never enters this queue.
export class AccountBandwidth {
  constructor(accounts) { this.accounts = accounts; this.buckets = new Map(); }
  take(owner, direction, bytes, signal) {
    if (signal.aborted) return Promise.reject(new Error('TRANSFER_CANCELLED'));
    const key = owner + ':' + direction;
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= 128) return Promise.reject(new Error('TRANSFER_LIMIT'));
      bucket = { owner, direction, tokens: 8192, updated: performance.now(), queue: [], idle: Date.now() };
      this.buckets.set(key, bucket);
    }
    if (bucket.queue.length >= 32 || bytes > 8192 || bytes < 1) return Promise.reject(new Error('TRANSFER_LIMIT'));
    return new Promise((resolve, reject) => {
      const job = { bytes, resolve, reject, signal };
      job.cancel = () => {
        const i = bucket.queue.indexOf(job);
        if (i >= 0) bucket.queue.splice(i, 1);
        signal.removeEventListener('abort', job.cancel); reject(new Error('TRANSFER_CANCELLED')); this.pump(key, bucket);
      };
      bucket.queue.push(job); signal.addEventListener('abort', job.cancel, { once: true });
      this.pump(key, bucket);
    });
  }
  pump(key, bucket) {
    clearTimeout(bucket.timer);
    const rate = this.accounts.policy(bucket.owner)[bucket.direction + '_bps'];
    const now = performance.now();
    bucket.tokens = Math.min(8192, bucket.tokens + (now - bucket.updated) * rate / 1000); bucket.updated = now;
    while (bucket.queue.length && bucket.tokens >= bucket.queue[0].bytes) {
      const job = bucket.queue.shift(); bucket.tokens -= job.bytes;
      job.signal.removeEventListener('abort', job.cancel); job.resolve();
    }
    if (bucket.queue.length) bucket.timer = setTimeout(() => this.pump(key, bucket), Math.max(1, Math.ceil((bucket.queue[0].bytes - bucket.tokens) * 1000 / rate)));
    else bucket.timer = setTimeout(() => { if (!bucket.queue.length) this.buckets.delete(key); }, 60000);
    bucket.timer.unref();
  }
  close() {
    for (const bucket of this.buckets.values()) {
      clearTimeout(bucket.timer);
      for (const job of bucket.queue.splice(0)) { job.signal.removeEventListener('abort', job.cancel); job.reject(new Error('TRANSFER_CANCELLED')); }
    }
    this.buckets.clear();
  }
}
