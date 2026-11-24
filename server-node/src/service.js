import { createServer } from 'node:https';
import { randomUUID, X509Certificate } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import app from './app.js';
import { loadTlsOptions } from './tls.js';
import { openAccounts } from './accounts.js';
import { AuthManager } from './auth.js';
import { UploadStore } from './upload-store.js';
import { ConnectionUploads } from './uploads.js';
import { ConnectionDownloads } from './downloads.js';
import { dirname, join } from 'node:path';
import { AccountBandwidth } from './bandwidth.js';

export const limits = Object.freeze({ messageBytes: 16 * 1024, textLength: 1024, connections: 64, sendQueueBytes: 64 * 1024 });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// Options are injectable for tests; the production entry point uses these defaults.
export function createService({ tlsOptions = loadTlsOptions(), heartbeatIntervalMs = 15000, pongTimeoutMs = 10000, shutdownMs = 5000, accountStore, authOptions, uploadOptions = {} } = {}) {
  const server = createServer({ ...tlsOptions, maxHeaderSize: 8192, requestTimeout: 10000, headersTimeout: 10000 }, app);
  const accounts = accountStore ?? openAccounts();
  const authentication = new AuthManager(accounts, authOptions);
  if (authentication.mode === 'mtls-required' && (!tlsOptions.requestCert || tlsOptions.rejectUnauthorized !== true)) {
    if (!accountStore) accounts.close();
    throw new Error('mTLS mode requires mandatory validated TLS client certificates');
  }
  let uploadStore;
  try { uploadStore = new UploadStore(uploadOptions.directory ?? join(dirname(accounts.filename), 'uploads'), uploadOptions.policy, uploadOptions.hooks); }
  catch (error) { if (!accountStore) accounts.close(); throw error; }
  uploadStore.bandwidth = new AccountBandwidth(accounts);
  const retention = setInterval(() => { try { uploadStore.sweep(); } catch { uploadStore.failed = true; } }, 60000); retention.unref();
  const sessions = new Set();
  const uploadSessions = new Set();
  const cleanups = new Set();
  const cleanupUpload = (upload) => {
    const cleanup = upload.dispose(); cleanups.add(cleanup);
    void cleanup.finally(() => { cleanups.delete(cleanup); uploadSessions.delete(upload); });
    return cleanup;
  };
  server.maxConnections = 96; // Also bounds pre-upgrade TCP/TLS connections.
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: limits.messageBytes, perMessageDeflate: false });
  let stopping = false;
  let stopPromise;
  const reject = (socket, status) => {
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    socket.setTimeout(1000, () => socket.destroy());
  };
  server.on('upgrade', (request, socket, head) => {
    socket.on('error', () => {});
    if (stopping || wss.clients.size >= limits.connections) return reject(socket, '503 Service Unavailable');
    if (request.url !== '/ws') return reject(socket, '404 Not Found');
    // This phase supports native clients, not cross-site browser connections.
    if (request.headers.origin) return reject(socket, '403 Forbidden');
    let fingerprint;
    if (authentication.mode === 'mtls-required') {
      const peer = socket.getPeerCertificate();
      if (!socket.authorized || !peer.raw) return reject(socket, '403 Forbidden');
      const cert = new X509Certificate(peer.raw);
      if (cert.ca || !cert.keyUsage?.includes('1.3.6.1.5.5.7.3.2') || Date.now() < Date.parse(cert.validFrom) || Date.now() >= Date.parse(cert.validTo)) return reject(socket, '403 Forbidden');
      fingerprint = cert.fingerprint256.replaceAll(':', '').toLowerCase();
    }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, fingerprint));
  });
  wss.on('connection', (ws, fingerprint) => {
    const connectionId = randomUUID();
    let pendingPong;
    let pongDeadline;
    let closeDeadline;
    const close = (code, reason) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.close(code, reason);
      closeDeadline ??= setTimeout(() => ws.terminate(), shutdownMs);
      closeDeadline.unref();
    };
    const send = (message) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      const body = JSON.stringify(message);
      if (Buffer.byteLength(body) > limits.messageBytes) return close(1009, 'Response message limit');
      if (ws.bufferedAmount + Buffer.byteLength(body) > limits.sendQueueBytes) return close(1013, 'Send queue limit');
      ws.send(body, { binary: false, compress: false }, (error) => { if (error) ws.terminate(); });
    };
    const auth = authentication.attach((message) => send({ version: 1, connectionId, ...message }), close,
      () => !stopping && ws.readyState === WebSocket.OPEN);
    auth.peerFingerprint = fingerprint;
    sessions.add(auth);
    const upload = new ConnectionUploads(uploadStore, auth, connectionId,
      (message) => send({ version: 1, connectionId, ...message }), close);
    uploadSessions.add(upload);
    const sendBinary = (frame, check) => new Promise((resolveSend, rejectSend) => {
      try {
        check();
        if (stopping || ws.readyState !== WebSocket.OPEN) throw new Error('DOWNLOAD_CANCELLED');
        if (frame.length > limits.messageBytes || ws.bufferedAmount + frame.length > limits.sendQueueBytes) {
          close(1013, 'Send queue limit'); throw new Error('DOWNLOAD_CANCELLED');
        }
        ws.send(frame, { binary: true, compress: false }, error => {
          if (error) { ws.terminate(); rejectSend(new Error('DOWNLOAD_CANCELLED')); } else resolveSend();
        });
      } catch (error) { rejectSend(error); }
    });
    const download = new ConnectionDownloads(uploadStore, auth, connectionId,
      message => send({ version: 1, connectionId, ...message }), sendBinary, close,
      () => Boolean(upload.item || upload.busy || upload.cancelling));
    upload.otherActive = () => Boolean(download.item || download.busy || download.cancelling);
    auth.onInvalidate = () => { void upload.invalidate('AUTH_REQUIRED'); void download.invalidate(); };
    uploadSessions.add(download); // Both directions participate in the same shutdown and budget.
    ws.on('error', () => {
      // ws has already sent the appropriate protocol close (e.g. 1009).
      closeDeadline ??= setTimeout(() => ws.terminate(), shutdownMs);
      closeDeadline.unref();
    });
    ws.on('pong', (data) => {
      if (pendingPong && data.equals(pendingPong)) {
        pendingPong = undefined;
        clearTimeout(pongDeadline);
      }
    });
    const heartbeat = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN || pendingPong) return;
      pendingPong = Buffer.from(randomUUID());
      ws.ping(pendingPong, false, (error) => { if (error) ws.terminate(); });
      pongDeadline = setTimeout(() => ws.terminate(), pongTimeoutMs);
      pongDeadline.unref();
    }, heartbeatIntervalMs);
    heartbeat.unref();
    ws.on('close', () => {
      auth.dispose();
      cleanupUpload(upload);
      cleanupUpload(download);
      sessions.delete(auth);
      clearInterval(heartbeat);
      clearTimeout(pongDeadline);
      clearTimeout(closeDeadline);
      pendingPong = undefined;
    });
    ws.on('message', (raw, binary) => {
      if (binary) { upload.binary(raw); return; }
      let message;
      try { message = JSON.parse(raw.toString('utf8')); }
      catch { return send({ version: 1, type: 'ERROR', code: 'INVALID_JSON', connectionId }); }
      const requestId = object(message) && typeof message.requestId === 'string' && uuid.test(message.requestId) ? message.requestId : undefined;
      if (!object(message) || message.version !== 1 || !requestId || !object(message.data)
        || !['ECHO', 'AUTH_LOGIN', 'AUTH_ME', 'AUTH_LOGOUT', 'UPLOAD_BEGIN', 'UPLOAD_COMPLETE', 'UPLOAD_CANCEL',
          'FILES_LIST', 'DOWNLOAD_BEGIN', 'DOWNLOAD_CHUNK', 'DOWNLOAD_COMPLETE', 'DOWNLOAD_CANCEL',
          'AUTH_CERT', 'AUTH_WINDOW', 'AUTH_ATTACH', 'UPLOAD_OPEN', 'UPLOAD_STATUS', 'UPLOAD_RESUME', 'UPLOAD_PAUSE', 'UPLOAD_FORGET', 'DOWNLOAD_OPEN'].includes(message.type)) {
        return send({ version: 1, type: 'ERROR', code: 'INVALID_MESSAGE', ...(requestId ? { requestId } : {}), connectionId });
      }
      if (message.type.startsWith('AUTH_')) { auth.handle(message); return; }
      if (message.type.startsWith('UPLOAD_')) { upload.handle(message); return; }
      if (message.type === 'FILES_LIST' || message.type.startsWith('DOWNLOAD_')) { download.handle(message); return; }
      if (typeof message.data.text !== 'string' || message.data.text.length > limits.textLength) {
        return send({ version: 1, type: 'ERROR', code: 'INVALID_MESSAGE', requestId, connectionId });
      }
      send({ version: 1, type: 'ECHO_RESULT', requestId, data: { text: message.data.text }, connectionId });
    });
    send({ version: 1, type: 'HELLO', connectionId, data: { capabilities: ['window-auth-v1', 'resume-v1', 'account-bandwidth-v1'], authMode: authentication.mode } });
  });

  function stop() {
    if (stopPromise) return stopPromise;
    stopping = true;
    clearInterval(retention);
    authentication.close();
    for (const session of sessions) session.dispose();
    for (const upload of uploadSessions) cleanupUpload(upload);
    stopPromise = new Promise((resolve, rejectStop) => {
      const deadline = setTimeout(() => {
        for (const ws of wss.clients) ws.terminate();
        for (const socket of sockets) socket.destroy();
        if (cleanups.size) rejectStop(new Error('Upload cleanup exceeded shutdown deadline; recovery required on next start.'));
      }, shutdownMs);
      const wsClosed = new Promise((resolveWs) => wss.close(resolveWs));
      for (const ws of wss.clients) ws.close(1001, 'Server shutting down');
      const httpClosed = new Promise((resolveHttp, rejectHttp) => {
        server.close((error) => error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? rejectHttp(error) : resolveHttp());
      });
      Promise.all([wsClosed, httpClosed, ...cleanups]).then(() => {
        uploadStore.bandwidth.close();
        uploadStore.close();
        if (!accountStore) accounts.close();
        resolve();
      }, rejectStop).finally(() => clearTimeout(deadline));
    });
    return stopPromise;
  }
  return { server, wss, stop, authentication, uploadStore };
}
