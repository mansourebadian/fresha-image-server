// image-server/server.mjs
// سرور تصویر سبک با Node خالص — بدون وابستگی خارجی
// قابلیت‌ها: سرو فایل استاتیک، ETag، کش مرورگر، CORS، محافظت از Path Traversal

import { createServer } from 'node:http';
import { stat, readdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, normalize, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT ?? 4001);
const HOST = process.env.HOST ?? '0.0.0.0';
const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), 'images');

const MIME_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
};

const CACHE_CONTROL = 'public, max-age=86400, stale-while-revalidate=604800';

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function buildEtag(stats) {
  return `"${createHash('md5').update(`${stats.size}-${stats.mtimeMs}`).digest('hex')}"`;
}

// جلوگیری از خروج مسیر درخواستی از پوشه images
function resolveSafePath(urlPathname) {
  const decoded = decodeURIComponent(urlPathname);
  const relative = normalize(decoded).replace(/^([/\\])+/, '');
  const absolute = join(ROOT, relative);
  if (absolute !== ROOT && !absolute.startsWith(ROOT + sep)) {
    return null;
  }
  return absolute;
}

async function handleListImages(res) {
  const entries = await readdir(ROOT, { withFileTypes: true });
  const images = entries
    .filter((entry) => entry.isFile() && MIME_TYPES[extname(entry.name).toLowerCase()])
    .map((entry) => ({ name: entry.name, url: `/images/${encodeURIComponent(entry.name)}` }));
  sendJson(res, 200, { count: images.length, images });
}

async function handleImage(req, res, pathname) {
  const filePath = resolveSafePath(pathname.replace(/^\/images/, ''));
  if (!filePath) {
    return sendJson(res, 400, { error: 'مسیر درخواستی نامعتبر است' });
  }

  const mime = MIME_TYPES[extname(filePath).toLowerCase()];
  if (!mime) {
    return sendJson(res, 415, { error: 'فرمت فایل پشتیبانی نمی‌شود' });
  }

  let stats;
  try {
    stats = await stat(filePath);
    if (!stats.isFile()) throw new Error('not a file');
  } catch {
    return sendJson(res, 404, { error: 'تصویر پیدا نشد' });
  }

  const etag = buildEtag(stats);
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag, 'Cache-Control': CACHE_CONTROL });
    return res.end();
  }

  res.writeHead(200, {
    'Content-Type': mime,
    'Content-Length': stats.size,
    'Cache-Control': CACHE_CONTROL,
    ETag: etag,
    'Access-Control-Allow-Origin': '*',
  });

  if (req.method === 'HEAD') return res.end();

  const stream = createReadStream(filePath);
  stream.on('error', () => {
    if (!res.headersSent) sendJson(res, 500, { error: 'خطا در خواندن فایل' });
    else res.destroy();
  });
  stream.pipe(res);
}

const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url, `http://${req.headers.host}`);

  if (!['GET', 'HEAD'].includes(req.method)) {
    return sendJson(res, 405, { error: 'فقط GET و HEAD مجاز است' });
  }

  try {
    if (pathname === '/health') {
      return sendJson(res, 200, { status: 'ok' });
    }
    if (pathname === '/images' || pathname === '/images/') {
      return await handleListImages(res);
    }
    if (pathname.startsWith('/images/')) {
      return await handleImage(req, res, pathname);
    }
    return sendJson(res, 404, { error: 'یافت نشد' });
  } catch (error) {
    console.error('[image-server]', error);
    return sendJson(res, 500, { error: 'خطای داخلی سرور' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[image-server] running on http://localhost:${PORT}`);
  console.log(`[image-server] serving images from ${ROOT}`);
});
