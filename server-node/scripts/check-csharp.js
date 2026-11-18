import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:https';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { createService } from '../src/service.js';
import { loadTlsOptions, defaultCertDirectory } from '../src/tls.js';

// Isolated test fixtures; never exposed by npm start.
const service = createService();
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
    if (request.data.text === 'oversize') return ws.send('x'.repeat(16385));
    if (request.data.text === 'binary') return ws.send(Buffer.from('binary'));
    if (request.data.text === 'bad-json') return ws.send('{');
    fragmented({ ...request, type: 'ECHO_RESULT', connectionId });
  });
});
let child;
try {
  service.server.listen(8443, '127.0.0.1');
  await once(service.server, 'listening');
  fixture.listen(0, '127.0.0.1');
  await once(fixture, 'listening');
  const project = fileURLToPath(new URL('../../SecureFileTransfer.Client/SecureFileTransfer.ConnectionChecks/SecureFileTransfer.ConnectionChecks.csproj', import.meta.url));
  child = spawn('dotnet', ['run', '--project', project, '--no-build', '--', join(defaultCertDirectory, 'public/dev-ca.crt'), 'wss://127.0.0.1:8443/ws', `wss://127.0.0.1:${fixture.address().port}/ws`, '--expect-server-stop', '--tls-fixture-script', fileURLToPath(new URL('./tls-negative-fixture.js', import.meta.url))], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (data) => {
    process.stdout.write(data);
    output += data.toString();
    if (output.includes('READY_FOR_SERVER_STOP')) void service.stop();
  });
  child.stderr.on('data', (data) => process.stderr.write(data));
  const deadline = setTimeout(() => { child.kill(); }, 120000);
  try {
    const [code] = await once(child, 'exit');
    if (code !== 0) throw new Error(`C# checks exited ${code}`);
  } finally { clearTimeout(deadline); }
} catch (error) {
  console.error(`[C# checks] ${error.code ?? error.message}`);
  process.exitCode = 1;
} finally {
  await service.stop();
  for (const ws of wss.clients) ws.terminate();
  await new Promise((resolve) => wss.close(resolve));
  if (fixture.listening) await new Promise((resolve) => fixture.close(resolve));
}
