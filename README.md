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
| `GET /images` (Bearer token required) | لیست JSON تمام تصاویر موجود |
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
curl -X POST http://localhost:4001/images -H "Authorization: Bearer $IMAGE_SERVER_TOKEN" -F "image=@photo.jpg"
curl -X POST http://localhost:4001/images -H "Authorization: Bearer $IMAGE_SERVER_TOKEN" -H "Content-Type: image/jpeg" --data-binary "@photo.jpg"
```

JPEG, PNG, GIF, WebP and AVIF are supported. Uploads are streamed to a temporary file and renamed after checking the file signature. Failed uploads are cleaned up. A signature check does not validate the entire image.

## Upload resource limits

All settings are positive integers:

| Environment variable | Default | Purpose |
|---|---:|---|
| `MAX_UPLOAD_BYTES` | 10485760 | Maximum image size in bytes; multipart requests may include up to 65536 bytes of overhead |
| `STORAGE_QUOTA_BYTES` | Unset | Optional maximum bytes in the image directory and ongoing uploads |
| `MIN_FREE_BYTES` | 1073741824 | Disk space to leave free for the server and other applications |
| `MAX_CONCURRENT_UPLOADS` | 4 | Maximum concurrent uploads in this process |
| `UPLOAD_RATE_LIMIT` | 120 | Maximum upload requests per IP per rate window |
| `UPLOAD_RATE_WINDOW_MS` | 60000 | Rate window in milliseconds |
| `UPLOAD_TIMEOUT_MS` | 60000 | Maximum upload duration in milliseconds |

Exceeding the size, rate or concurrency, timeout, and storage limits returns 413, 429, 408, and 507 respectively. Rate limiting uses the direct connection IP. Behind a reverse proxy, users may share the proxy IP, so also configure per-client limits on the trusted proxy. Client-supplied IP headers are not trusted.

Storage usage is initialized from files in the root of `images` and maintained in this process. Correct enforcement requires a single server instance to own writes to this directory. Multiple instances or external changes require shared storage quota coordination. After an abrupt shutdown, temporary `.upload-` files may remain and count against the quota on restart.

## Access control

Set `IMAGE_SERVER_TOKEN` to a long, randomly generated secret before starting the server. Startup fails if it is missing. The web application backend must authenticate and authorize its users, then send `Authorization: Bearer <IMAGE_SERVER_TOKEN>` when uploading or listing images. Keep the token on the backend; never expose it in browser code. Public clients can retrieve individual images without a token. Use HTTPS between services and configure the web application to proxy browser uploads through its backend. The web application must be updated separately to use this interface.

The optional storage quota limits this process?s image usage; without it, uploads are limited by available disk space and `MIN_FREE_BYTES`. Configure the reserve for the server?s actual capacity and other workloads. Free-space checks cannot guarantee space against other processes writing concurrently; disk-full errors return 507.

For local testing, create a `.env` file in the project root containing `IMAGE_SERVER_TOKEN=sample-image-token-2026-local-test-only` and run `npm start` (Node.js 22.9 or later). The example token is public and must be replaced with a strong, unique secret in production. `.env` is ignored by Git. When running `node server.mjs` directly, set `IMAGE_SERVER_TOKEN` in the process environment instead; production deployments may provide the environment variable through their service manager.
