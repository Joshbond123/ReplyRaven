import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
const root = resolve(process.env.STATIC_ROOT || '.'),
  port = Number(process.env.PORT || 3000),
  backend = process.env.DEV_API_URL || 'http://127.0.0.1:8787';
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
};
http
  .createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://static.invalid');
      if (url.pathname.startsWith('/api/')) {
        const chunks = [];
        for await (const chunk of req) {
          chunks.push(chunk);
          if (chunks.reduce((sum, item) => sum + item.length, 0) > 65536) {
            res.writeHead(413);
            return res.end('Request too large');
          }
        }
        const headers = { Origin: 'http://127.0.0.1:3000' };
        for (const name of ['authorization', 'content-type'])
          if (req.headers[name]) headers[name] = req.headers[name];
        const response = await fetch(`${backend}${url.pathname.slice(4)}${url.search}`, {
          method: req.method,
          headers,
          ...(!['GET', 'HEAD'].includes(req.method) ? { body: Buffer.concat(chunks) } : {}),
          signal: AbortSignal.timeout(90000),
        });
        res.writeHead(response.status, {
          'Content-Type': response.headers.get('Content-Type') || 'application/json',
          'Cache-Control': 'no-store',
        });
        return res.end(Buffer.from(await response.arrayBuffer()));
      }
      const path = decodeURIComponent(url.pathname),
        parts = path.split('/');
      if (
        parts.some(
          (part) =>
            part.startsWith('.') ||
            [
              'node_modules',
              'backend',
              'scripts',
              'checks',
              'package.json',
              'package-lock.json',
              'wrangler.jsonc',
              'README.md',
            ].includes(part),
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
      res.writeHead(req.url.startsWith('/api/') ? 503 : 404, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: req.url.startsWith('/api/')
            ? 'The API could not be reached. Start the local API or configure the deployed worker endpoint.'
            : 'Not found',
        }),
      );
    }
  })
  .listen(port, '0.0.0.0', () => console.log(`ReplyRaven website is available on port ${port}.`));
