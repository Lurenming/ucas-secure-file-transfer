// Persistent manual acceptance server; roots/ports come only from the prepared isolated fixture.
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
const root = fileURLToPath(new URL('../../artifacts/acceptance-20261125/manual/', import.meta.url));
const name = process.argv[2];
if (!['password', 'mtls'].includes(name) || !existsSync(join(root, '.sft-acceptance'))) throw new Error('Prepare the isolated fixture; choose password or mtls');
const config = JSON.parse(readFileSync(join(root, 'fixture.json'), 'utf8')), mode = config.modes[name];
process.env.SFT_DATA_DIR = mode.data; process.env.SFT_CERT_DIR = config.certs; process.env.SFT_AUTH_MODE = mode.authMode;
const { createService } = await import('../src/service.js');
const service = createService({ uploadOptions: { policy: { quotaBytes: config.quotaBytesPerServer } } });
const runningFile = join(root, `running-${name}.json`), observedFile = join(root, `observations-${name}.json`);
const evidence = { startedAt: new Date().toISOString(), mode: name, peakUploads: 0, peakDownloads: 0, simultaneousTwoEach: false, peakConnections: 0, samples: [] };
let timer, stopping;
async function stop() {
  if (stopping) return stopping;
  stopping = (async () => {
    clearInterval(timer); await service.stop();
    evidence.endedAt = new Date().toISOString(); evidence.connectionsAfter = service.wss.clients.size; evidence.activeAfter = service.uploadStore.active.size;
    writeFileSync(observedFile, JSON.stringify(evidence, null, 2));
    if (existsSync(runningFile) && JSON.parse(readFileSync(runningFile)).pid === process.pid) unlinkSync(runningFile);
    process.stdin.pause(); console.log('Isolated acceptance server stopped.');
  })(); return stopping;
}
try {
  service.server.listen(mode.port, '127.0.0.1'); await once(service.server, 'listening');
  writeFileSync(runningFile, JSON.stringify({ pid: process.pid, port: mode.port, mode: name, data: mode.data, at: new Date().toISOString() }, null, 2));
  timer = setInterval(() => {
    const active = [...service.uploadStore.active], up = active.filter(x => x.kind !== 'download').length, down = active.length - up;
    evidence.peakUploads = Math.max(up, evidence.peakUploads); evidence.peakDownloads = Math.max(down, evidence.peakDownloads);
    evidence.peakConnections = Math.max(evidence.peakConnections, service.wss.clients.size); evidence.simultaneousTwoEach ||= up >= 2 && down >= 2;
    if (active.length && evidence.samples.length < 4000) evidence.samples.push({ at: new Date().toISOString(), up, down });
    writeFileSync(observedFile, JSON.stringify(evidence));
  }, 500);
  console.log(JSON.stringify({ mode: name, pid: process.pid, port: mode.port, data: mode.data, publicCa: config.publicCa }));
  process.on('SIGINT', () => void stop()); process.on('SIGTERM', () => void stop());
  process.stdin.resume(); process.stdin.on('data', value => { if (value.toString().trim() === 'stop') void stop(); });
} catch (error) { console.error(error); await stop(); process.exitCode = 1; }
