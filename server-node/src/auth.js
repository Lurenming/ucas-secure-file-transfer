import { normalizeUsername } from './accounts.js';
import { validPassword, verifyPasswordBytes } from './passwords.js';
import { WindowAuth } from './window-auth.js';
import { authMode } from './connection-config.js';

export const authPolicy = Object.freeze({
  sessionMs: 15 * 60 * 1000, unauthenticatedMs: 120000,
  maxActive: 2, maxQueued: 4, queueWaitMs: 3000,
  connectionBurst: 5, connectionRefillMs: 12000,
  globalBurst: 20, globalRefillMs: 3000, failureDelayMs: 1000,
});

const errors = Object.freeze({
  AUTH_FAILED: '用户名或密码错误', AUTH_REQUIRED: '请先登录',
  AUTH_ALREADY_LOGGED_IN: '请先注销再切换账户', AUTH_BUSY: '登录校验正在进行',
  AUTH_RATE_LIMITED: '登录尝试过于频繁，请稍后重试', AUTH_SERVER_BUSY: '认证服务繁忙，请稍后重试',
  AUTH_CANCELLED: '登录已取消', INVALID_MESSAGE: '消息格式或字段无效', INTERNAL_ERROR: '请求暂时无法完成',
});

class Bucket {
  constructor(capacity, refillMs) { this.capacity = capacity; this.refillMs = refillMs; this.tokens = capacity; this.updated = performance.now(); }
  take() {
    const now = performance.now();
    this.tokens = Math.min(this.capacity, this.tokens + (now - this.updated) / this.refillMs);
    this.updated = now;
    if (this.tokens < 1) return false;
    this.tokens--;
    return true;
  }
}

// At most two native scrypt jobs and four queued closures; no user/IP keyed state tables.
export class AuthManager {
  constructor(store, options = {}) {
    this.store = store;
    this.mode = authMode(options.mode);
    this.windows = new WindowAuth(this);
    this.policy = { ...authPolicy, ...options };
    this.active = 0;
    this.queue = [];
    this.closed = false;
    this.globalBucket = new Bucket(this.policy.globalBurst, this.policy.globalRefillMs);
  }
  run(work, signal) {
    if (this.closed || signal.aborted) return Promise.reject(new Error('AUTH_CANCELLED'));
    if (this.active >= this.policy.maxActive && this.queue.length >= this.policy.maxQueued) return Promise.reject(new Error('AUTH_SERVER_BUSY'));
    return new Promise((resolve, reject) => {
      const task = { work, resolve, reject, signal };
      const remove = (code) => {
        const index = this.queue.indexOf(task);
        if (index >= 0) { this.queue.splice(index, 1); this.detach(task); reject(new Error(code)); }
      };
      task.cancel = () => remove('AUTH_CANCELLED');
      if (this.active < this.policy.maxActive) this.start(task);
      else {
        this.queue.push(task);
        task.timer = setTimeout(() => remove('AUTH_SERVER_BUSY'), this.policy.queueWaitMs);
        signal.addEventListener('abort', task.cancel, { once: true });
      }
    });
  }
  detach(task) { clearTimeout(task.timer); task.signal.removeEventListener('abort', task.cancel); }
  start(task) {
    this.detach(task);
    this.active++;
    Promise.resolve().then(() => {
      if (task.signal.aborted) throw new Error('AUTH_CANCELLED');
      return task.work();
    }).then(task.resolve, task.reject).finally(() => {
      this.active--;
      while (!this.closed && this.active < this.policy.maxActive && this.queue.length) this.start(this.queue.shift());
    });
  }
  close() {
    this.closed = true;
    for (const task of this.queue.splice(0)) { this.detach(task); task.reject(new Error('AUTH_CANCELLED')); }
  }
  attach(send, closeConnection, isOpen) { return new ConnectionAuth(this, send, closeConnection, isOpen); }
}

class ConnectionAuth {
  constructor(manager, send, closeConnection, isOpen) {
    this.manager = manager;
    this.send = send;
    this.closeConnection = closeConnection;
    this.isOpen = isOpen;
    this.generation = 0;
    this.identity = null;
    this.attempt = null;
    this.disposed = false;
    this.failures = 0;
    this.nextAttempt = 0;
    this.bucket = new Bucket(manager.policy.connectionBurst, manager.policy.connectionRefillMs);
    this.beginUnauthenticatedWait();
  }
  error(requestId, code) { this.send({ type: 'ERROR', requestId, code, message: errors[code] ?? errors.INTERNAL_ERROR }); }
  beginUnauthenticatedWait() {
    clearTimeout(this.waitTimer);
    this.unauthenticatedDeadline = Date.now() + this.manager.policy.unauthenticatedMs;
    this.waitTimer = setTimeout(() => {
      this.dispose();
      this.closeConnection(1008, 'Authentication wait expired');
    }, this.manager.policy.unauthenticatedMs);
    this.waitTimer.unref();
  }
  invalidate() {
    this.manager.windows.leave(this);
    this.generation++;
    this.attempt?.controller.abort();
    this.identity = null;
    clearTimeout(this.sessionTimer);
    this.onInvalidate?.();
  }
  expireIfNeeded() {
    if (this.identity?.fingerprint && !this.manager.store.certificate(this.identity.fingerprint)) {
      this.invalidate(); this.beginUnauthenticatedWait(); this.send({ type: 'AUTH_EXPIRED', data: {} });
      return;
    }
    if (this.identity && Date.now() < this.identity.expiresAt) {
      clearTimeout(this.sessionTimer);
      this.sessionTimer = setTimeout(() => this.expireIfNeeded(), Math.min(this.identity.expiresAt - Date.now(), this.identity.fingerprint ? 1000 : this.manager.policy.sessionMs));
      this.sessionTimer.unref();
      return;
    }
    if (this.identity && Date.now() >= this.identity.expiresAt) {
      this.invalidate();
      this.beginUnauthenticatedWait();
      this.send({ type: 'AUTH_EXPIRED', data: {} });
    }
  }
  handle(message) {
    if (this.disposed || !this.isOpen()) return;
    this.expireIfNeeded();
    const { type, requestId, data } = message;
    if (type === 'AUTH_WINDOW') {
      try { this.send({ type: 'AUTH_WINDOW_RESULT', requestId, data: this.manager.windows.open(this) }); }
      catch (error) { this.error(requestId, error.message); } return;
    }
    if (type === 'AUTH_CERT' || type === 'AUTH_ATTACH') {
      try {
        if (this.identity) throw new Error('AUTH_ALREADY_LOGGED_IN');
        if (this.attempt) throw new Error('AUTH_BUSY');
        if (!this.bucket.take() || Date.now() >= this.unauthenticatedDeadline) throw new Error('AUTH_RATE_LIMITED');
        let user;
        if (type === 'AUTH_CERT') {
          const row = this.peerFingerprint && this.manager.store.certificate(this.peerFingerprint);
          if (!row || Date.now() >= Date.parse(row.not_after)) throw new Error('AUTH_FAILED');
          if (data.username !== undefined && data.username !== row.username) throw new Error('AUTH_FAILED');
          user = { userId: row.user_id, username: row.username, fingerprint: row.fingerprint,
            expiresAt: Math.min(Date.now() + this.manager.policy.sessionMs, Date.parse(row.not_after)) };
        } else {
          user = this.manager.windows.attach(this, data.ticket); delete data.ticket;
        }
        this.generation++; this.identity = user; clearTimeout(this.waitTimer); this.expireIfNeeded();
        this.send({ type: type + '_RESULT', requestId, data: this.publicIdentity() });
      } catch (error) { this.error(requestId, error.message); } return;
    }
    if (type === 'AUTH_LOGOUT') {
      const wasAuthenticated = Boolean(this.identity);
      this.invalidate();
      if (wasAuthenticated) this.beginUnauthenticatedWait(); // Repeated unauthenticated logout cannot extend the wait.
      this.send({ type: 'AUTH_LOGOUT_RESULT', requestId, data: {} });
    } else if (type === 'AUTH_ME') {
      if (!this.identity) return this.error(requestId, 'AUTH_REQUIRED');
      this.send({ type: 'AUTH_ME_RESULT', requestId, data: this.publicIdentity() });
    } else if (type === 'AUTH_LOGIN') {
      if (this.manager.mode === 'mtls-required') { delete data.password; return this.error(requestId, 'AUTH_FAILED'); }
      // Discard the parsed password field immediately; no raw messages are logged.
      const password = data.password;
      delete data.password;
      let username;
      try { username = normalizeUsername(data.username); } catch { return this.error(requestId, 'INVALID_MESSAGE'); }
      if (!validPassword(password)) return this.error(requestId, 'INVALID_MESSAGE');
      if (this.identity) return this.error(requestId, 'AUTH_ALREADY_LOGGED_IN');
      if (this.attempt) return this.error(requestId, 'AUTH_BUSY');
      if (performance.now() < this.nextAttempt || !this.bucket.take() || !this.manager.globalBucket.take()) return this.error(requestId, 'AUTH_RATE_LIMITED');
      const attempt = { controller: new AbortController(), generation: ++this.generation };
      this.attempt = attempt;
      const input = Buffer.from(password, 'utf8');
      const work = async () => {
        // The indexed database read is short; async scrypt runs in libuv, not the event loop.
        const record = this.manager.store.findByUsername(username);
        const valid = await verifyPasswordBytes(input, record);
        return valid ? { userId: record.user_id, username: record.username } : null;
      };
      void this.manager.run(work, attempt.controller.signal).then((user) => {
        if (this.disposed || !this.isOpen() || this.generation !== attempt.generation || attempt.controller.signal.aborted) return this.error(requestId, 'AUTH_CANCELLED');
        if (Date.now() >= this.unauthenticatedDeadline) { this.dispose(); this.closeConnection(1008, 'Authentication wait expired'); return; }
        if (!user) {
          this.failures = Math.min(4, this.failures + 1);
          this.nextAttempt = performance.now() + this.manager.policy.failureDelayMs * 2 ** (this.failures - 1);
          return this.error(requestId, 'AUTH_FAILED');
        }
        this.failures = 0;
        this.identity = { ...user, expiresAt: Date.now() + this.manager.policy.sessionMs };
        clearTimeout(this.waitTimer);
        this.sessionTimer = setTimeout(() => this.expireIfNeeded(), this.manager.policy.sessionMs);
        this.sessionTimer.unref();
        this.send({ type: 'AUTH_LOGIN_RESULT', requestId, data: this.publicIdentity() });
      }, (error) => this.error(requestId, Object.hasOwn(errors, error.message) ? error.message : 'INTERNAL_ERROR'))
        .finally(() => { input.fill(0); if (this.attempt === attempt) this.attempt = null; });
    }
  }
  publicIdentity() { return { userId: this.identity.userId, username: this.identity.username, expiresAt: new Date(this.identity.expiresAt).toISOString() }; }
  snapshot() {
    this.expireIfNeeded();
    return !this.disposed && this.isOpen() && this.identity ? { userId: this.identity.userId, generation: this.generation } : null;
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.invalidate();
    clearTimeout(this.waitTimer);
  }
}
