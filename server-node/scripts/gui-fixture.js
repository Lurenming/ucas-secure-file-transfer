// Isolated manual GUI test service. Never used by the production launcher.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { once } from 'node:events';
import { createService } from '../src/service.js';
import { createAccount } from '../src/passwords.js';
const directory = resolve(process.argv[2]);
if (!directory.includes('artifacts') || !directory.includes('gui-enhanced')) throw new Error('Dedicated GUI fixture directory required');
mkdirSync(directory, { recursive: false });
process.env.SFT_DATA_DIR = join(directory, 'data');
const service = createService();
await createAccount(service.authentication.store, 'gui_alice', 'GUI-isolated-2026!');
const owner = service.authentication.store.findByUsername('gui_alice').user_id;
service.authentication.store.db.prepare('INSERT INTO account_policy VALUES (?,?,?,?)').run(owner, 'ordinary', 65536, 65536);
mkdirSync(join(directory, 'sources')); mkdirSync(join(directory, 'downloads')); mkdirSync(join(directory, 'client'));
for (let i = 0; i < 2; i++) {
  const bytes = randomBytes(2 * 1024 * 1024), name = `gui-download-${i}.bin`;
  const item = service.uploadStore.reserve(owner, randomUUID(), 1, name, bytes.length);
  await service.uploadStore.create(item); await service.uploadStore.write(item, bytes);
  await service.uploadStore.publish(item, createHash('sha256').update(bytes).digest('hex'), () => {});
  writeFileSync(join(directory, 'sources', `gui-upload-${i}.bin`), randomBytes(2 * 1024 * 1024));
}
service.server.listen(0, '127.0.0.1'); await once(service.server, 'listening');
const port = service.server.address().port;
writeFileSync(join(directory, 'client/connection.json'), JSON.stringify({ Host: '127.0.0.1', Port: port, PublicCa: join(process.env.SFT_CERT_DIR, 'public/dev-ca.crt'), Concurrency: 4 }));
const evidence = { port, owner, peakUploads: 0, peakDownloads: 0, simultaneousTwoEach: false, connections: [], samples: [] };
service.wss.on('connection', () => { evidence.connections.push(new Date().toISOString()); });
const timer = setInterval(() => {
  const active = [...service.uploadStore.active], up = active.filter(x => x.kind !== 'download').length, down = active.filter(x => x.kind === 'download').length;
  evidence.peakUploads = Math.max(evidence.peakUploads, up); evidence.peakDownloads = Math.max(evidence.peakDownloads, down);
  evidence.simultaneousTwoEach ||= up >= 2 && down >= 2;
  if (active.length && evidence.samples.length < 5000) evidence.samples.push({ at: new Date().toISOString(), up, down });
  writeFileSync(join(directory, 'observations.json'), JSON.stringify(evidence));
}, 250);
console.log(JSON.stringify({ port, directory, pid: process.pid }));
async function stop() { clearInterval(timer); await service.stop(); }
process.on('SIGINT', () => void stop()); process.on('SIGTERM', () => void stop());
process.stdin.resume(); process.stdin.on('data', data => { if (data.toString().trim() === 'stop') void stop().then(() => process.stdin.pause()); });
