// image-server/server.mjs
// سرور تصویر سبک با Node خالص — بدون وابستگی خارجی
// قابلیت‌ها: سرو فایل استاتیک، ETag، کش مرورگر، CORS، محافظت از Path Traversal

import { createServer } from 'node:http';
import { stat, statfs, readdir, open, unlink, rename } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { join, normalize, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import Busboy from 'busboy';

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

function positiveInt(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}
const MAX_UPLOAD_SIZE = positiveInt('MAX_UPLOAD_BYTES', 10 * 1024 * 1024);
const MAX_REQUEST_SIZE = MAX_UPLOAD_SIZE + 64 * 1024;
const STORAGE_QUOTA = process.env.STORAGE_QUOTA_BYTES ? positiveInt('STORAGE_QUOTA_BYTES') : Infinity;
const MIN_FREE_BYTES = positiveInt('MIN_FREE_BYTES', 1024 * 1024 * 1024);
const UPLOAD_TOKEN = process.env.IMAGE_SERVER_TOKEN;
if (!UPLOAD_TOKEN) throw new Error('IMAGE_SERVER_TOKEN is required');

function authorized(req) {
  const header = req.headers.authorization ?? '';
  const expected = Buffer.from(`Bearer ${UPLOAD_TOKEN}`);
  const actual = Buffer.from(header);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
const MAX_CONCURRENT = positiveInt('MAX_CONCURRENT_UPLOADS', 4);
const RATE_LIMIT = positiveInt('UPLOAD_RATE_LIMIT', 120);
const RATE_WINDOW = positiveInt('UPLOAD_RATE_WINDOW_MS', 60_000);
const UPLOAD_TIMEOUT = positiveInt('UPLOAD_TIMEOUT_MS', 60_000);
const rateEntries = new Map();
let activeUploads = 0;
let storageUsed = 0;
let storageReserved = 0;

async function initialStorageUsage() {
  const entries = await readdir(ROOT, { withFileTypes: true });
  const sizes = await Promise.all(entries.filter(entry => entry.isFile()).map(async entry => (await stat(join(ROOT, entry.name))).size));
  return sizes.reduce((sum, size) => sum + size, 0);
}

function allowUpload(ip) {
  const now = Date.now();
  // Bound the map and discard expired entries to prevent rate limiting itself exhausting memory.
  for (const [key, entry] of rateEntries) if (entry.reset <= now) rateEntries.delete(key);
  let entry = rateEntries.get(ip);
  if (!entry) {
    if (rateEntries.size >= 10000) return false;
    entry = { count: 0, reset: now + RATE_WINDOW };
    rateEntries.set(ip, entry);
  }
  return ++entry.count <= RATE_LIMIT;
}

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
  const multipart = /^multipart\/form-data(?:\s*;|$)/i.test(contentType);
  if (!multipart && !/^image\//i.test(contentType)) {
    res.setHeader('Connection', 'close');
    req.resume();
    return sendJson(res, 415, { error: 'Expected multipart/form-data or an image content type' });
  }
  if (!allowUpload(req.socket.remoteAddress ?? 'unknown')) {
    res.setHeader('Connection', 'close'); req.resume();
    return sendJson(res, 429, { error: 'Upload rate limit exceeded' });
  }
  if (activeUploads >= MAX_CONCURRENT) {
    res.setHeader('Connection', 'close'); req.resume();
    return sendJson(res, 429, { error: 'Too many concurrent uploads' });
  }
  const length = req.headers['content-length'];
  if (length && Number(length) > (multipart ? MAX_REQUEST_SIZE : MAX_UPLOAD_SIZE)) {
    res.setHeader('Connection', 'close'); req.resume();
    return sendJson(res, 413, { error: 'Upload is too large' });
  }
  activeUploads++;
  const tempPath = join(ROOT, `.upload-${randomUUID()}.tmp`);
  let file, parser, fileTask, timer, result, reserved = 0, committed = false;
  let failure;
  const fail = (status, message) => {
    if (failure) return;
    failure = Object.assign(new Error(message), { status });
    if (parser && !parser.destroyed) parser.destroy(failure);
    req.unpipe();
    // Stop receiving immediately; close the connection after the error response.
    req.pause();
  };
  try {
    file = await open(tempPath, 'wx');
    timer = setTimeout(() => {
      fail(408, 'Upload timed out');
      if (!res.headersSent) { res.setHeader('Connection', 'close'); sendJson(res, 408, { error: 'Upload timed out' }); }
      if (!req.destroyed) res.once('finish', () => req.destroy());
    }, UPLOAD_TIMEOUT);
    let received = 0, prefix = Buffer.alloc(0);
    const save = async (stream) => {
      for await (const chunk of stream) {
        if (failure) throw failure;
        if (reserved + chunk.length > MAX_UPLOAD_SIZE) throw Object.assign(new Error('Image is too large'), { status: 413 });
        if (storageUsed + storageReserved + chunk.length > STORAGE_QUOTA) throw Object.assign(new Error('Storage quota exceeded'), { status: 507 });
        reserved += chunk.length;
        storageReserved += chunk.length;
        const disk = await statfs(ROOT);
        if (disk.bavail * disk.bsize < MIN_FREE_BYTES + storageReserved) throw Object.assign(new Error('Insufficient free disk space'), { status: 507 });
        if (prefix.length < 64) prefix = Buffer.concat([prefix, chunk.subarray(0, 64 - prefix.length)]);
        let offset = 0;
        while (offset < chunk.length) offset += (await file.write(chunk, offset, chunk.length - offset)).bytesWritten;
      }
    };
    if (multipart) {
      try { parser = Busboy({ headers: req.headers, limits: { files: 1, fields: 0, fileSize: MAX_UPLOAD_SIZE + 1, fieldNameSize: 100, headerPairs: 100 } }); }
      catch { throw Object.assign(new Error('Invalid multipart request'), { status: 400 }); }
      let fileCount = 0;
      parser.on('error', () => {});
      parser.on('file', (name, stream) => {
        fileCount++;
        if (name !== 'image') { stream.resume(); fail(400, 'Provide one file in the image field'); return; }
        stream.on('limit', () => fail(413, 'Image is too large'));
        fileTask = save(stream).catch(error => { fail(error.status ?? 500, error.message); throw error; });
        fileTask.catch(() => {});
      });
      for (const event of ['filesLimit', 'fieldsLimit']) parser.on(event, () => fail(400, 'Provide one file in the image field'));
      const parsed = new Promise((resolve, reject) => {
        parser.once('close', () => failure ? reject(failure) : resolve());
        parser.once('error', reject);
      });
      parsed.catch(() => {});
      req.on('data', chunk => {
        received += chunk.length;
        if (received > MAX_REQUEST_SIZE) fail(413, 'Upload is too large');
      });
      req.once('aborted', () => fail(400, 'Upload interrupted'));
      req.once('error', () => fail(400, 'Upload interrupted'));
      req.pipe(parser);
      await parsed;
      if (fileTask) await fileTask;
      if (failure) throw failure;
      if (fileCount !== 1 || !fileTask) throw Object.assign(new Error('Provide one file in the image field'), { status: 400 });
    } else {
      await save(req);
    }
    const extension = imageExtension(prefix);
    if (!extension) throw Object.assign(new Error('Only JPEG, PNG, GIF, AVIF and WebP images are supported'), { status: 415 });
    await file.close(); file = undefined;
    const name = `${randomUUID()}${extension}`;
    await rename(tempPath, join(ROOT, name));
    storageUsed += reserved;
    committed = true;
    result = { name, url: `/images/${name}` };
  } catch (error) {
    const reason = failure ?? error;
    if (reason.code === 'ENOSPC' || reason.code === 'EDQUOT') { reason.status = 507; reason.message = 'Insufficient storage space'; }
    if (!res.headersSent && !res.destroyed) {
      res.setHeader('Connection', 'close');
      sendJson(res, reason.status ?? 400, { error: reason.status ? reason.message : 'Invalid or interrupted upload' });
    }
    req.resume();
  } finally {
    clearTimeout(timer);
    if (fileTask) await fileTask.catch(() => {});
    if (file) await file.close().catch(() => {});
    if (!committed) await unlink(tempPath).catch(() => {});
    storageReserved -= reserved;
    activeUploads--;
  }
  if (result && !res.destroyed) sendJson(res, 201, result);
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
    if (!authorized(req)) { req.resume(); return sendJson(res, 401, { error: 'Unauthorized' }); }
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
      if (!authorized(req)) return sendJson(res, 401, { error: 'Unauthorized' });
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

storageUsed = await initialStorageUsage();
server.listen(PORT, HOST, () => {
  console.log(`[image-server] running on http://localhost:${PORT}`);
  console.log(`[image-server] serving images from ${ROOT}`);
});
