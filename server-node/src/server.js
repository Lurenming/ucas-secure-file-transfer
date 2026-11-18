import { createService } from './service.js';

const host = '127.0.0.1';
const port = 8443;
try {
  const service = createService();
  service.server.on('error', (error) => {
    console.error(error.code === 'EADDRINUSE'
      ? `[server] Cannot listen on https://${host}:${port}: port ${port} is already in use (EADDRINUSE). No other process was stopped.`
      : `[server] HTTPS server error: ${error.code ?? error.message}`);
    process.exitCode = 1;
    void service.stop().catch(() => { process.exitCode = 1; });
  });
  service.server.listen(port, host, () => {
    const address = service.server.address();
    console.log(`[server] Listening on https://${address.address}:${address.port}; WSS /ws (P1, TLS >= 1.2, local only)`);
  });
  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`[server] Received ${signal}; stopping HTTPS and WebSockets...`);
    try {
      await service.stop();
      console.log('[server] Stopped; listening port released.');
    } catch (error) {
      console.error(`[server] Shutdown failed: ${error.code ?? error.message}`);
      process.exitCode = 1;
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
} catch (error) {
  console.error(`[server] Startup failed: ${error.message}`);
  process.exitCode = 1;
}
