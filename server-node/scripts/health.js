import { get } from 'node:https';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultCertDirectory } from '../src/tls.js';

try {
  const ca = readFileSync(join(defaultCertDirectory, 'public/dev-ca.crt'));
  const host = process.env.SFT_CONNECT_HOST || '127.0.0.1';
  const port = Number(process.env.SFT_PORT || 8443);
  if (['0.0.0.0', '::'].includes(host) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid client health destination');
  const identity = process.env.SFT_HEALTH_CERT && process.env.SFT_HEALTH_KEY ? { cert: readFileSync(process.env.SFT_HEALTH_CERT), key: readFileSync(process.env.SFT_HEALTH_KEY) } : {};
  const request = get({ hostname: host, port, path: '/health', ca, minVersion: 'TLSv1.2', ...identity }, (response) => {
    let body = '';
    response.on('data', (chunk) => { body += chunk; });
    response.on('end', () => {
      console.log(`HTTP ${response.statusCode}\n${body}`);
      if (response.statusCode !== 200) process.exitCode = 1;
    });
    response.on('error', () => { console.error('HTTPS response failed.'); process.exitCode = 1; });
  });
  request.setTimeout(5000, () => request.destroy(new Error('HTTPS timeout')));
  request.on('error', (error) => { console.error(`HTTPS check failed: ${error.code ?? error.message}`); process.exitCode = 1; });
} catch (error) {
  console.error(`HTTPS check failed: ${error.code ?? error.message}`);
  process.exitCode = 1;
}
