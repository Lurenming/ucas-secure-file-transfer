import { createService } from '../src/service.js';
const service = createService();
service.server.listen(0, '127.0.0.1', () => process.send({ port: service.server.address().port }));
process.on('message', async value => { if (value === 'stop') { await service.stop(); process.disconnect(); } });
