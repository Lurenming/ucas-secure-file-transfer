import { createServer } from 'node:https';

// Test-only TLS peer for the C# negative certificate checks. Nothing is written to disk.
let configuration = '';
for await (const chunk of process.stdin) configuration += chunk;
try {
  const { key, cert } = JSON.parse(configuration);
  configuration = '';
  const server = createServer({ key, cert, minVersion: 'TLSv1.2' }, (_request, response) => response.end('test fixture'));
  server.on('error', () => { process.exitCode = 1; });
  server.listen(0, '127.0.0.1', () => console.log(server.address().port));
} catch {
  console.error('TLS fixture failed'); // Never emit received configuration or private key material.
  process.exitCode = 1;
}
