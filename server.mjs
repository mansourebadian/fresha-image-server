// image-server/server.mjs
// سرور تصویر سبک با Node خالص — بدون وابستگی خارجی
// قابلیت‌ها: سرو فایل استاتیک، ETag، کش مرورگر، CORS، محافظت از Path Traversal

import { createServer } from 'node:http';
import { stat, readdir, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
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

const MAX_UPLOAD_SIZE = 45 * 1024 * 1024;
const MAX_REQUEST_SIZE = MAX_UPLOAD_SIZE + 1024 * 1024;

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

function imageExtension(data) {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return '.jpg';
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return '.png';
  if (data.length >= 6 && ['GIF87a', 'GIF89a'].includes(data.toString('ascii', 0, 6))) return '.gif';
  if (data.length >= 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') return '.webp';
  if (data.length >= 16 && data.toString('ascii', 4, 8) === 'ftyp') {
    if (['avif', 'avis'].includes(data.toString('ascii', 8, 12))) return '.avif';
    for (let offset = 16; offset + 4 <= Math.min(data.length, 64); offset += 4) {
      if (['avif', 'avis'].includes(data.toString('ascii', offset, offset + 4))) return '.avif';
    }
  }
  return null;
}

async function handleUpload(req, res) {
  const contentType = req.headers['content-type'] ?? '';
  if (!contentType.toLowerCase().startsWith('multipart/form-data') && !contentType.toLowerCase().startsWith('image/')) {
    req.resume();
    return sendJson(res, 415, { error: 'Expected multipart/form-data or an image content type' });
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_REQUEST_SIZE) {
      req.resume();
      return sendJson(res, 413, { error: 'Image is too large (maximum 45 MB)' });
    }
    chunks.push(chunk);
  }
  let data = Buffer.concat(chunks);
  if (contentType.toLowerCase().startsWith('multipart/form-data')) {
    try {
      const form = await new Request('http://localhost/', { method: 'POST', headers: { 'content-type': contentType }, body: data }).formData();
      const files = form.getAll('image');
      if (files.length !== 1 || typeof files[0] === 'string' || [...form.keys()].length !== 1) {
        return sendJson(res, 400, { error: 'Provide one file in the image field' });
      }
      data = Buffer.from(await files[0].arrayBuffer());
    } catch {
      return sendJson(res, 400, { error: 'Invalid multipart request' });
    }
  }
  if (data.length > MAX_UPLOAD_SIZE) return sendJson(res, 413, { error: 'Image is too large (maximum 45 MB)' });
  const extension = imageExtension(data);
  if (!extension) return sendJson(res, 415, { error: 'Only JPEG, PNG, GIF, AVIF and WebP images are supported' });
  const name = `${randomUUID()}${extension}`;
  await writeFile(join(ROOT, name), data, { flag: 'wx' });
  return sendJson(res, 201, { name, url: `/images/${name}` });
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

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' });
    return res.end();
  }

  if (req.method === 'POST' && (pathname === '/images' || pathname === '/images/')) {
    try { return await handleUpload(req, res); }
    catch (error) {
      console.error('[image-server]', error);
      if (!res.headersSent) return sendJson(res, 500, { error: 'Upload failed' });
      return;
    }
  }

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
