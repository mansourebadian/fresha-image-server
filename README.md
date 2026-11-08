# سرور تصویر (Image Server)

A lightweight Node.js image server using Busboy for streaming multipart uploads.

## اجرا

```bash
npm install
node server.mjs
# یا
npm start
```

پورت پیش‌فرض `4001` است و با متغیر محیطی `PORT` قابل تغییر است.

## مسیرها (Endpoints)

| مسیر | توضیح |
|---|---|
| `GET /health` | بررسی سلامت سرور |
| `GET /images` | لیست JSON تمام تصاویر موجود |
| `GET /images/<نام-فایل>` | دریافت تصویر |

## افزودن تصویر

فایل‌های تصویر (`jpg`, `png`, `webp`, `gif`, `svg`, `avif`) را داخل پوشه `images/` قرار دهید؛ بدون نیاز به ری‌استارت سرو می‌شوند.

## قابلیت‌ها

- کش مرورگر با `Cache-Control` و `ETag` (پاسخ `304`)
- هدر CORS برای استفاده از دامنه‌های دیگر
- محافظت در برابر Path Traversal
- پشتیبانی از `HEAD` برای health-check تصاویر

## Image uploads

Upload one file in the `image` multipart field or send raw image bytes:

```bash
curl -X POST http://localhost:4001/images -F "image=@photo.jpg"
curl -X POST http://localhost:4001/images -H "Content-Type: image/jpeg" --data-binary "@photo.jpg"
```

JPEG, PNG, GIF, WebP and AVIF are supported. Uploads are streamed to a temporary file and renamed after checking the file signature. Failed uploads are cleaned up. A signature check does not validate the entire image.

## Upload resource limits

All settings are positive integers:

| Environment variable | Default | Purpose |
|---|---:|---|
| `MAX_UPLOAD_BYTES` | 10485760 | Maximum image size in bytes; multipart requests may include up to 65536 bytes of overhead |
| `STORAGE_QUOTA_BYTES` | 1073741824 | Maximum bytes in the image directory and ongoing uploads |
| `MAX_CONCURRENT_UPLOADS` | 4 | Maximum concurrent uploads in this process |
| `UPLOAD_RATE_LIMIT` | 120 | Maximum upload requests per IP per rate window |
| `UPLOAD_RATE_WINDOW_MS` | 60000 | Rate window in milliseconds |
| `UPLOAD_TIMEOUT_MS` | 60000 | Maximum upload duration in milliseconds |

Exceeding the size, rate or concurrency, timeout, and storage limits returns 413, 429, 408, and 507 respectively. Rate limiting uses the direct connection IP. Behind a reverse proxy, users may share the proxy IP, so also configure per-client limits on the trusted proxy. Client-supplied IP headers are not trusted.

Storage usage is initialized from files in the root of `images` and maintained in this process. Correct enforcement requires a single server instance to own writes to this directory. Multiple instances or external changes require shared storage quota coordination. After an abrupt shutdown, temporary `.upload-` files may remain and count against the quota on restart.
