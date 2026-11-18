import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:https';
import { randomUUID, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { createService } from '../src/service.js';
import { loadTlsOptions, defaultCertDirectory } from '../src/tls.js';
import { temporaryAccounts } from '../test/helpers.js';
import { createAccount } from '../src/passwords.js';

// Isolated test fixtures; never exposed by npm start.
const accounts = temporaryAccounts();
const service = createService({ accountStore: accounts.store });
const expiring = createService({ accountStore: accounts.store, authOptions: { sessionMs: 600 } });
const waiting = createService({ accountStore: accounts.store, authOptions: { unauthenticatedMs: 750 } });
const fixture = createServer(loadTlsOptions());
const wss = new WebSocketServer({ server: fixture, path: '/ws', perMessageDeflate: false, maxPayload: 16384 });
wss.on('connection', (ws) => {
  ws.on('error', () => {});
  const connectionId = randomUUID();
  const fragmented = (message) => {
    const body = JSON.stringify(message);
    ws.send(body.slice(0, 12), { fin: false });
    ws.send(body.slice(12), { fin: true });
  };
  fragmented({ version: 1, type: 'HELLO', connectionId });
  ws.on('message', (raw) => {
    const request = JSON.parse(raw.toString());
    if (request.type === 'AUTH_LOGIN') {
      const requestId = request.requestId;
      delete request.data.password;
      const timer = setTimeout(() => {
        if (ws.readyState === 1) fragmented({ version: 1, type: 'AUTH_LOGIN_RESULT', requestId, connectionId,
          data: { userId: randomUUID(), username: 'alice', expiresAt: new Date(Date.now() + 60000).toISOString() } });
      }, 100);
      ws.once('close', () => clearTimeout(timer));
      return;
    }
    if (request.type === 'AUTH_LOGOUT') return fragmented({ version: 1, type: 'AUTH_LOGOUT_RESULT', requestId: request.requestId, connectionId, data: {} });
    if (request.data.text === 'oversize') return ws.send('x'.repeat(16385));
    if (request.data.text === 'binary') return ws.send(Buffer.from('binary'));
    if (request.data.text === 'bad-json') return ws.send('{');
    fragmented({ ...request, type: 'ECHO_RESULT', connectionId });
  });
});
let child;
const password = randomBytes(24).toString('base64url');
try {
  await createAccount(accounts.store, 'alice', password);
  await createAccount(accounts.store, 'bob', password);
  service.server.listen(0, '127.0.0.1');
  await once(service.server, 'listening');
  fixture.listen(0, '127.0.0.1');
  await once(fixture, 'listening');
  for (const extra of [expiring, waiting]) { extra.server.listen(0, '127.0.0.1'); await once(extra.server, 'listening'); }
  const assembly = fileURLToPath(new URL('../../SecureFileTransfer.Client/SecureFileTransfer.ConnectionChecks/bin/Debug/net10.0/SecureFileTransfer.ConnectionChecks.dll', import.meta.url));
  child = spawn('dotnet', [assembly, join(defaultCertDirectory, 'public/dev-ca.crt'), `wss://127.0.0.1:${service.server.address().port}/ws`, `wss://127.0.0.1:${fixture.address().port}/ws`, '--auth-stdin', '--expect-server-stop', '--tls-fixture-script', fileURLToPath(new URL('./tls-negative-fixture.js', import.meta.url))], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdin.on('error', () => {});
  child.stdin.end(JSON.stringify({ username: 'alice', secondUsername: 'bob', password,
    expiryAddress: `wss://127.0.0.1:${expiring.server.address().port}/ws`, waitingAddress: `wss://127.0.0.1:${waiting.server.address().port}/ws` }) + '\n');
  let output = '';
  child.stdout.on('data', (data) => {
    output += data.toString();
    if (output.includes('READY_FOR_SERVER_STOP')) void service.stop();
  });
  child.stderr.on('data', (data) => { output += data.toString(); });
  console.log('Running C# TLS, authentication and 61-second idle checks with temporary accounts; credentials stay in a private stdin pipe.');
  const deadline = setTimeout(() => { child.kill(); }, 150000);
  try {
    const [code] = await once(child, 'exit');
    const record = accounts.store.findByUsername('alice');
    if ([password, Buffer.from(record.password_hash).toString('hex'), Buffer.from(record.password_hash).toString('base64')].some(secret => output.includes(secret))) {
      throw new Error('Sensitive test output suppressed');
    }
    process.stdout.write(output);
    if (code !== 0) throw new Error(`C# checks exited ${code}`);
  } finally { clearTimeout(deadline); }
} catch (error) {
  console.error(`[C# checks] ${error.code ?? error.message}`);
  process.exitCode = 1;
} finally {
  await service.stop();
  await expiring.stop();
  await waiting.stop();
  for (const ws of wss.clients) ws.terminate();
  await new Promise((resolve) => wss.close(resolve));
  if (fixture.listening) await new Promise((resolve) => fixture.close(resolve));
  accounts.cleanup();
}
