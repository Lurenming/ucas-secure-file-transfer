import assert from 'node:assert/strict';
import { once } from 'node:events';
import { get } from 'node:https';
import { createServer } from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createService } from '../src/service.js';
import { defaultCertDirectory } from '../src/tls.js';
import { temporaryAccounts } from '../test/helpers.js';

const accounts = temporaryAccounts();
let service;
try {
  service = createService({ accountStore: accounts.store });
  service.server.listen(0, '127.0.0.1');
  await once(service.server, 'listening');
  const port = service.server.address().port;
  console.log(`[runtime] Node ${process.version}; ${process.execPath}`);
  console.log(`[smoke] https://127.0.0.1:${port}/health; isolated database, strict CA validation`);
  const body = await new Promise((resolve, reject) => {
    const req = get(`https://127.0.0.1:${port}/health`, {
      ca: readFileSync(join(defaultCertDirectory, 'public/dev-ca.crt')), minVersion: 'TLSv1.2'
    }, res => {
      let text = '';
      res.on('data', chunk => { text += chunk; if (text.length > 16384) req.destroy(new Error('Health response too large')); });
      res.on('error', reject);
      res.on('end', () => { try { assert.equal(res.statusCode, 200); resolve(JSON.parse(text)); } catch (error) { reject(error); } });
    });
    req.on('error', reject); req.setTimeout(5000, () => req.destroy(new Error('Health timeout')));
  });
  assert.deepEqual(body, { status: 'ok', service: 'SecureFileTransfer.Server', stage: 'EnhancedV1', softwareVersion: '4.0.0', capabilities: ['window-auth-v1', 'resume-v1', 'account-bandwidth-v1'] });
  console.log(JSON.stringify(body));
  await service.stop();
  const probe = createServer().listen(port, '127.0.0.1');
  await once(probe, 'listening'); await new Promise(resolve => probe.close(resolve));
  console.log('[smoke] PASS: HTTPS health, graceful stop, same port rebound');
} finally { await service?.stop(); accounts.cleanup(); }
