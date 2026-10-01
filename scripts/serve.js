import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
const root = process.cwd();
const port = Number(process.env.PORT || 3000);
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.md': 'text/plain; charset=utf-8',
  '.json': 'application/json',
};
http
  .createServer(async (req, res) => {
    try {
      const path = decodeURIComponent(new URL(req.url, 'http://static.invalid').pathname);
      if (
        path
          .split('/')
          .some(
            (part) =>
              part.startsWith('.') ||
              ['node_modules', 'scripts', 'tests', 'package-lock.json', 'package.json'].includes(part),
          )
      ) {
        res.writeHead(404);
        return res.end('Not found');
      }
      let file = resolve(root, `.${path}`);
      if (file !== root && !file.startsWith(`${root}${sep}`)) {
        res.writeHead(403);
        return res.end('Forbidden');
      }
      if ((await stat(file)).isDirectory()) file = resolve(file, 'index.html');
      const bytes = await readFile(file);
      res.writeHead(200, {
        'Content-Type': mime[extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'strict-origin-when-cross-origin',
      });
      res.end(req.method === 'HEAD' ? undefined : bytes);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    }
  })
  .listen(port, '0.0.0.0', () => console.log(`ReplyRaven is ready on http://0.0.0.0:${port}`));
