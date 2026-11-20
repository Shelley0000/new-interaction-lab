/* Tiny zero-dependency static server for Star Wanderer.
 * Camera access requires a secure context: http://localhost and 127.0.0.1 qualify.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const root = __dirname;
const port = Number(process.argv[2] || process.env.PORT || 5178);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.task': 'application/octet-stream',
  '.tflite': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    res.writeHead(400); res.end('Bad request'); return;
  }
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(root, path.normalize(urlPath).replace(/^([/\\])+/, ''));
  if (!filePath.startsWith(root)) { res.writeHead(403); res.end('Forbidden'); return; }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found: ' + urlPath);
      return;
    }
    const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': stat.size,
      'Cache-Control': 'no-store',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
    });
    fs.createReadStream(filePath).pipe(res);
  });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`\n  端口 ${port} 已经有服务在运行。`);
    console.log(`  如果那就是星际漫游，直接打开 http://127.0.0.1:${port}\n`);
    process.exit(0);
  }
  console.error(err);
  process.exit(1);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`\n  星际漫游 STAR WANDERER\n  http://127.0.0.1:${port}\n`);
});
