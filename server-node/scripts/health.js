import { get } from 'node:https';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultCertDirectory } from '../src/tls.js';

try {
  const ca = readFileSync(join(defaultCertDirectory, 'public/dev-ca.crt'));
  const request = get('https://127.0.0.1:8443/health', { ca, minVersion: 'TLSv1.2' }, (response) => {
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
