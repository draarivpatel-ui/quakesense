import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const assets = /^(?:index\.html|styles\.css|favicon\.svg|src\/[a-z0-9-]+\.js)$/;
const types = { html: 'text/html', css: 'text/css', js: 'text/javascript', svg: 'image/svg+xml' };

export function serve() {
  return createServer(async (req, res) => {
    const pathname = req.url.split('?')[0];
    const path = pathname === '/' ? 'index.html' : pathname.slice(1);
    if (!['GET', 'HEAD'].includes(req.method) || !pathname.startsWith('/') || !assets.test(path)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' }).end('Not found');
      return;
    }
    try {
      const bytes = await readFile(new URL(path, root));
      res.writeHead(200, {
        'Content-Type': `${types[path.split('.').at(-1)]}; charset=utf-8`,
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Cache-Control': 'no-store',
        'Content-Security-Policy': "frame-ancestors 'none'",
      }).end(bytes);
    } catch {
      res.writeHead(404).end('Not found');
    }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  serve().listen(Number(process.env.PORT ?? 4173), '127.0.0.1', function () {
    console.log(`QuakeSense listening at http://127.0.0.1:${this.address().port}`);
  });
}
