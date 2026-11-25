import http from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.csv': 'text/csv; charset=utf-8',
};

/**
 * Serve a directory on 127.0.0.1 so local HTML targets run over http://
 * (same behaviour as a real site: same-origin rules, downloads, history).
 */
export async function serveDirectory(root) {
  const base = path.resolve(root);
  const server = http.createServer(async (req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      let file = path.resolve(base, '.' + pathname);
      if (file !== base && !file.startsWith(base + path.sep)) return end(res, 403);
      let info = await stat(file).catch(() => null);
      if (info?.isDirectory()) {
        file = path.join(file, 'index.html');
        info = await stat(file).catch(() => null);
      }
      if (!info?.isFile()) return end(res, 404);
      res.writeHead(200, {
        'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
        'cache-control': 'no-store',
      });
      createReadStream(file).pipe(res);
    } catch {
      end(res, 400);
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    urlFor(file) {
      return `http://127.0.0.1:${port}/` + path.relative(base, file).split(path.sep).map(encodeURIComponent).join('/');
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function end(res, code) {
  res.writeHead(code);
  res.end();
}
