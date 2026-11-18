import { createServer } from 'node:https';
import { randomUUID } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import app from './app.js';
import { loadTlsOptions } from './tls.js';
import { openAccounts } from './accounts.js';
import { AuthManager } from './auth.js';

export const limits = Object.freeze({ messageBytes: 16 * 1024, textLength: 1024, connections: 32, sendQueueBytes: 64 * 1024 });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// Options are injectable for tests; the production entry point uses these defaults.
export function createService({ tlsOptions = loadTlsOptions(), heartbeatIntervalMs = 15000, pongTimeoutMs = 10000, shutdownMs = 5000, accountStore, authOptions } = {}) {
  const server = createServer({ ...tlsOptions, maxHeaderSize: 8192, requestTimeout: 10000, headersTimeout: 10000 }, app);
  const accounts = accountStore ?? openAccounts();
  const authentication = new AuthManager(accounts, authOptions);
  const sessions = new Set();
  server.maxConnections = 64; // Also bounds pre-upgrade TCP/TLS connections.
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
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws));
  });
  wss.on('connection', (ws) => {
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
      if (ws.bufferedAmount + Buffer.byteLength(body) > limits.sendQueueBytes) return close(1013, 'Send queue limit');
      ws.send(body, { binary: false, compress: false }, (error) => { if (error) ws.terminate(); });
    };
    const auth = authentication.attach((message) => send({ version: 1, connectionId, ...message }), close,
      () => !stopping && ws.readyState === WebSocket.OPEN);
    sessions.add(auth);
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
      sessions.delete(auth);
      clearInterval(heartbeat);
      clearTimeout(pongDeadline);
      clearTimeout(closeDeadline);
      pendingPong = undefined;
    });
    ws.on('message', (raw, binary) => {
      if (binary) return close(1003, 'Text messages only');
      let message;
      try { message = JSON.parse(raw.toString('utf8')); }
      catch { return send({ version: 1, type: 'ERROR', code: 'INVALID_JSON', connectionId }); }
      const requestId = object(message) && typeof message.requestId === 'string' && uuid.test(message.requestId) ? message.requestId : undefined;
      if (!object(message) || message.version !== 1 || !requestId || !object(message.data)
        || !['ECHO', 'AUTH_LOGIN', 'AUTH_ME', 'AUTH_LOGOUT'].includes(message.type)) {
        return send({ version: 1, type: 'ERROR', code: 'INVALID_MESSAGE', ...(requestId ? { requestId } : {}), connectionId });
      }
      if (message.type.startsWith('AUTH_')) { auth.handle(message); return; }
      if (typeof message.data.text !== 'string' || message.data.text.length > limits.textLength) {
        return send({ version: 1, type: 'ERROR', code: 'INVALID_MESSAGE', requestId, connectionId });
      }
      send({ version: 1, type: 'ECHO_RESULT', requestId, data: { text: message.data.text }, connectionId });
    });
    send({ version: 1, type: 'HELLO', connectionId });
  });

  function stop() {
    if (stopPromise) return stopPromise;
    stopping = true;
    authentication.close();
    for (const session of sessions) session.dispose();
    stopPromise = new Promise((resolve, rejectStop) => {
      const deadline = setTimeout(() => {
        for (const ws of wss.clients) ws.terminate();
        for (const socket of sockets) socket.destroy();
      }, shutdownMs);
      const wsClosed = new Promise((resolveWs) => wss.close(resolveWs));
      for (const ws of wss.clients) ws.close(1001, 'Server shutting down');
      const httpClosed = new Promise((resolveHttp, rejectHttp) => {
        server.close((error) => error && error.code !== 'ERR_SERVER_NOT_RUNNING' ? rejectHttp(error) : resolveHttp());
      });
      Promise.all([wsClosed, httpClosed]).then(() => {
        if (!accountStore) accounts.close();
        resolve();
      }, rejectStop).finally(() => clearTimeout(deadline));
    });
    return stopPromise;
  }
  return { server, wss, stop, authentication };
}
