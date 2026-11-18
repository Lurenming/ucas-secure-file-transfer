import { createServer } from 'node:http';
import app from './app.js';

// P0.1 仅供本机使用，暂不开放网络监听或环境变量覆盖。
const host = '127.0.0.1';
const port = 3000;
const server = createServer(app);

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`[server] Cannot listen on http://${host}:${port}: port ${port} is already in use (EADDRINUSE). No other process was stopped.`);
  } else {
    console.error(`[server] Server error: ${error.message}`);
  }
  process.exitCode = 1;
});

server.listen(port, host, () => {
  // 从实际监听结果读取地址，只有监听成功才打印。
  const address = server.address();
  console.log(`[server] Listening on http://${address.address}:${address.port} (P0.1, HTTP, local only)`);
});

let stopping = false;

function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`[server] Received ${signal}; stopping...`);

  // 停止接收新连接，等待已有请求结束。
  // 若连接一直未结束，最多等 5 秒，然后仅关闭本服务器的 HTTP 连接。
  const timeout = setTimeout(() => {
    console.error('[server] Shutdown timeout; closing remaining HTTP connections.');
    server.closeAllConnections();
  }, 5000);
  timeout.unref();

  server.close((error) => {
    clearTimeout(timeout);
    if (error) {
      console.error(`[server] Shutdown failed: ${error.message}`);
      process.exitCode = 1;
      return;
    }
    console.log('[server] Stopped; listening port released.');
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
