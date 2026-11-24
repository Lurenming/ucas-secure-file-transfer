import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { createService } from '../src/service.js';
import { defaultCertDirectory } from '../src/tls.js';
import { temporaryAccounts } from './helpers.js';
import { createAccount } from '../src/passwords.js';
import { encodeChunk } from '../src/upload-protocol.js';
import { decodeDownloadChunk } from '../src/download-protocol.js';

export const ca = readFileSync(join(defaultCertDirectory, 'public/dev-ca.crt'));
export const digest = data => createHash('sha256').update(data).digest('hex');
export const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function until(check, ms = 5000) {
  const deadline = Date.now() + ms;
  while (!check()) { if (Date.now() > deadline) throw new Error('Condition timeout'); await delay(10); }
}
export async function fixture(t, options = {}) {
  const accounts = temporaryAccounts();
  let service;
  try {
    service = createService({ accountStore: accounts.store, ...options });
    const password = randomBytes(24).toString('base64url');
    await createAccount(accounts.store, 'alice', password); await createAccount(accounts.store, 'bob', password);
    service.server.listen(0, '127.0.0.1'); await once(service.server, 'listening');
    t.after(async () => { await service.stop(); accounts.cleanup(); });
    return { ...service, password, accounts, port: service.server.address().port };
  } catch (error) { await service?.stop(); accounts.cleanup(); throw error; }
}
export async function peer(port, options = {}) {
  const ws = new WebSocket(`wss://127.0.0.1:${port}/ws`, { ca, ...options });
  const pending = new Map(), events = [], replies = [];
  let helloResolve;
  const helloPromise = new Promise(resolve => { helloResolve = resolve; });
  const closed = new Promise(resolve => ws.once('close', resolve));
  ws.on('error', () => {});
  ws.on('message', (raw, binary) => {
    const message = binary ? { type: 'DOWNLOAD_CHUNK_RESULT', ...decodeDownloadChunk(raw) } : JSON.parse(raw.toString()); replies.push(message);
    if (message.type === 'HELLO') helloResolve(message);
    else if (pending.has(message.requestId)) { const resolve = pending.get(message.requestId); pending.delete(message.requestId); resolve(message); }
    else events.push(message);
  });
  await once(ws, 'open'); const hello = await helloPromise;
  const response = (requestId, send) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('Upload response timeout')); }, 10000);
    pending.set(requestId, value => { clearTimeout(timer); resolve(value); }); send();
  });
  const request = (type, data = {}) => {
    const requestId = randomUUID();
    return response(requestId, () => ws.send(JSON.stringify({ version: 1, type, requestId, data })));
  };
  return { ws, hello, events, replies, closed, request,
    chunk: (uploadId, offset, data, fragmented = false) => {
      const requestId = randomUUID(), frame = encodeChunk(requestId, uploadId, offset, data);
      return response(requestId, () => {
        if (fragmented) { ws.send(frame.subarray(0, 35), { fin: false }); ws.send(frame.subarray(35), { fin: true }); }
        else ws.send(frame);
      });
    } };
}
export async function logged(f, username = 'alice') {
  const p = await peer(f.port), reply = await p.request('AUTH_LOGIN', { username, password: f.password });
  assert.equal(reply.type, 'AUTH_LOGIN_RESULT');
  p.identity = reply.data;
  return p;
}
export async function upload(p, bytes, name = '测试文件.txt') {
  const begin = await p.request('UPLOAD_BEGIN', { name, size: bytes.length });
  assert.equal(begin.type, 'UPLOAD_BEGIN_RESULT');
  const id = begin.data.uploadId;
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    const data = bytes.subarray(offset, offset + 8192), ack = await p.chunk(id, offset, data, true);
    assert.equal(ack.type, 'UPLOAD_CHUNK_RESULT'); assert.equal(ack.data.received, offset + data.length);
  }
  const result = await p.request('UPLOAD_COMPLETE', { uploadId: id, sha256: digest(bytes) });
  assert.equal(result.type, 'UPLOAD_COMPLETE_RESULT'); assert.equal(result.data.sha256, digest(bytes));
  return result.data;
}
