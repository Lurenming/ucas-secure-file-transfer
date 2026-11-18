import express from 'express';

// 只定义请求如何处理；导入本文件不会占用端口。
const app = express();

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'SecureFileTransfer.Server',
    stage: 'P0.2',
  });
});

// 放在路由之后，处理没有匹配到接口的请求。
app.use((_req, res) => {
  res.status(404).json({ error: 'Not Found' });
});

export default app;
