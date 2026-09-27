#!/usr/bin/env node
/**
 * 健康路径 HTTP 冒烟：
 *  构建产物（dist）启动最小静态服务器，请求 /health 与 /，断言 200 与内容，
 *  随后关闭并以退出码报告。供 npm run smoke 与 Compose verify 服务复用。
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const PORT = Number(process.env.SMOKE_PORT ?? 48173);
const HOST = '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
};

const server = createServer(async (req, res) => {
  try {
    let urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
    if (urlPath === '/') urlPath = '/index.html';
    const filePath = normalize(join(root, urlPath));
    if (!filePath.startsWith(root)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    const s = await stat(filePath).catch(() => null);
    if (!s || !s.isFile()) {
      res.writeHead(404).end('not found');
      return;
    }
    const body = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(500).end('error');
  }
});

const fail = (msg) => {
  console.error(`✗ 冒烟失败：${msg}`);
  server.close(() => process.exit(1));
};

server.listen(PORT, HOST, async () => {
  try {
    const health = await fetch(`http://${HOST}:${PORT}/health`);
    if (health.status !== 200) fail(`/health 状态码 ${health.status}`);
    const healthBody = (await health.text()).trim();
    if (healthBody !== 'ok') fail(`/health 内容异常：${healthBody}`);
    console.log('✓ GET /health -> 200 "ok"');

    const home = await fetch(`http://${HOST}:${PORT}/`);
    if (home.status !== 200) fail(`/ 状态码 ${home.status}`);
    const html = await home.text();
    if (!html.includes('<div id="root">')) fail('/ 未返回应用入口 HTML');
    console.log('✓ GET / -> 200 index.html');

    console.log('✓ 健康 HTTP 冒烟通过');
    server.close(() => process.exit(0));
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }
});
