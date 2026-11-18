import { createService } from '../src/service.js';

// Test-only process wrapper. No IPC control is added to the production entry point.
const service = createService();
service.server.listen(0, '127.0.0.1', () => process.send({ port: service.server.address().port }));
process.on('message', async (message) => {
  if (message !== 'stop') return;
  await service.stop();
  process.disconnect();
});
process.on('disconnect', () => { void service.stop(); });
