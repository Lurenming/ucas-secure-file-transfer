import { fork, spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { openAccounts } from '../src/accounts.js';
import { defaultCertDirectory } from '../src/tls.js';

let input = '';
for await (const chunk of process.stdin) input += chunk;
const credentials = JSON.parse(input);
input = '';
const ca = readFileSync(join(defaultCertDirectory, 'public/dev-ca.crt'));
const store = openAccounts(credentials.directory);
const record = store.findByUsername('alice');
if (!record || store.findByUsername('mismatch') || store.findByUsername('too_long')) throw new Error('CLI account creation state mismatch');
store.close();
let output = '';
function check(value, message) { if (!value) throw new Error(message); }

async function runOnce() {
  const child = fork(fileURLToPath(new URL('./server-child.js', import.meta.url)), [], {
    env: { ...process.env, SFT_DATA_DIR: credentials.directory }, silent: true, windowsHide: true,
  });
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  const deadline = setTimeout(() => child.kill(), 15000);
  let ws;
  try {
    const [ready] = await once(child, 'message');
    ws = new WebSocket(`wss://127.0.0.1:${ready.port}/ws`, { ca });
    ws.on('error', () => {});
    const [hello] = await once(ws, 'message');
    const connectionId = JSON.parse(hello).connectionId;
    const request = async (type, data = {}) => {
      const requestId = randomUUID();
      const response = once(ws, 'message');
      ws.send(JSON.stringify({ version: 1, type, requestId, data }));
      const [raw] = await response;
      output += raw.toString();
      const reply = JSON.parse(raw);
      check(reply.requestId === requestId, 'Request ID mismatch');
      return reply;
    };
    check((await request('AUTH_ME')).code === 'AUTH_REQUIRED', 'Fresh process/connection must start unauthenticated');
    const reply = await request('AUTH_LOGIN', { username: 'alice', password: credentials.password });
    check(reply.type === 'AUTH_LOGIN_RESULT' && reply.data.userId === record.user_id, 'CLI-created credentials did not survive restart');
    const closed = once(ws, 'close');
    const exited = once(child, 'exit');
    child.send('stop');
    check((await closed)[0] === 1001, 'Expected bounded graceful service close');
    check((await exited)[0] === 0, 'Service process failed on shutdown');
    const probe = net.createServer().listen(ready.port, '127.0.0.1');
    await once(probe, 'listening');
    await new Promise(resolve => probe.close(resolve));
    return connectionId;
  } finally {
    clearTimeout(deadline);
    ws?.terminate();
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill(); await exited;
    }
  }
}
const first = await runOnce();
const second = await runOnce();
check(first !== second, 'Restart must not inherit session');

// The existing 8443 listener is left untouched. If free, temporarily occupy it ourselves.
const blocker = net.createServer();
await new Promise((resolve, reject) => {
  blocker.once('error', error => error.code === 'EADDRINUSE' ? resolve() : reject(error));
  blocker.listen(8443, '127.0.0.1', resolve);
});
try {
  const process = spawn(globalThis.process.execPath, ['src/server.js'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), env: { ...globalThis.process.env, SFT_DATA_DIR: credentials.directory }, windowsHide: true,
  });
  let conflict = '';
  process.stdout.on('data', data => { conflict += data; });
  process.stderr.on('data', data => { conflict += data; });
  check((await once(process, 'exit'))[0] === 1 && conflict.includes('EADDRINUSE'), 'Production entry point must fail on port conflict');
  output += conflict;
} finally { if (blocker.listening) await new Promise(resolve => blocker.close(resolve)); }
check([credentials.password, Buffer.from(record.password_hash).toString('hex'), Buffer.from(record.password_hash).toString('base64')].every(secret => !output.includes(secret)), 'Sensitive output detected (withheld)');
console.log('PASS: CLI-created account logs in across two real backend processes; sessions do not survive reconnect/restart.');
console.log('PASS: both test processes close active WSS with 1001 and release their ports; production port conflict exits 1.');
console.log('PASS: captured service output and authentication responses contain no test password or hash.');
