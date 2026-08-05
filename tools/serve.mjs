#!/usr/bin/env node
// Static file server for development. ES modules will not load over file://,
// so `src/` needs an origin; `dist/` works either way.
//
//   node tools/serve.mjs [port]

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = Number(process.argv[2]) || 8080;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.json': 'application/json'
};

http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  let rel = url === '/' ? '/src/index.html' : url;
  if (rel.endsWith('/')) rel += 'index.html';

  const file = path.join(ROOT, rel);
  // never serve outside the project
  if (!file.startsWith(ROOT + path.sep)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found: ' + rel);
      return;
    }
    res.writeHead(200, {
      'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store'
    }).end(data);
  });
}).listen(PORT, () => {
  console.log(`  src   http://localhost:${PORT}/src/index.html   (live modules)`);
  console.log(`  dist  http://localhost:${PORT}/dist/index.html  (bundled)`);
  console.log(`  add #debug to either for the window.SPACESCIENCE hook\n`);
});
