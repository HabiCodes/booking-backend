# Phase 5 Production Readiness Review

## Overview

Phase 5 added: image uploads for events and banners, banner CRUD with activate/deactivate, automatic banner rendering on PDF tickets, a file-upload ledger, and full admin RBAC. The database layer, service layer, and controllers are all production-grade. Four pieces are **temporary** and need replacement before production deploy.

---

## 1. Base64 JSON Uploads — TEMPORARY

**Files:** `src/middleware/upload.ts`, `src/controllers/uploadController.ts`, `src/controllers/bannerController.ts`

**What's happening now:** The app accepts images as base64 strings inside JSON request bodies. The `jsonUploadMiddleware` parses `req.body.file` (a base64 string), decodes it to a `Buffer`, and attaches it to `req.upload.buffer`. Controllers pass that buffer straight to `saveUpload()`.

**Why it's temporary:**
- Base64 inflates payload by ~33% — a 5 MB image becomes a ~6.7 MB JSON body.
- The Express JSON parser buffers the entire body in memory as a UTF-8 string, then we decode it to a Buffer — two copies in memory simultaneously.
- No chunked transfer, no streaming, no upload progress.
- 15 MB JSON bodies are heavier for the server to parse than multipart form-data.

**Production replacement:** Replace `jsonUploadMiddleware` with `multer` using `memoryStorage`. Multer parses `multipart/form-data` and gives you a `Buffer` on `req.file.buffer` — exactly what `saveUpload()` already expects. The controller signatures don't change at all; only the middleware import and `req.upload` vs `req.file` access change.

```ts
// swap:
import { jsonUploadMiddleware } from '../middleware/upload';
router.post('/', jsonUploadMiddleware, uploadBannerImage);

// for:
import multer from 'multer';
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
router.post('/', upload.single('file'), uploadBannerImage);
```

**Effort:** ~1 hour. Zero breaking changes to services, repositories, or database.

---

## 2. Local Filesystem Storage — TEMPORARY

**Files:** `src/services/uploadService.ts`, `server.ts`

**What's happening now:** `saveUpload()` writes files to `./uploads/{events|banners|tickets}/` using `fs.writeFileSync`. URLs are returned as `/uploads/...` relative paths. The server does **not** currently mount `express.static` for the uploads directory, so these URLs 404 unless something else serves them.

**Why it's temporary:**
- Local disk doesn't survive server restarts on ephemeral infrastructure (Render, Fly, etc.).
- No CDN — users far from the server get slow image loads.
- No image optimisation pipeline (resize, compress, convert to WebP/AVIF).
- Disk space is finite; no lifecycle management (orphan cleanup, retention policies).

**Production replacement:** Move to an S3-compatible object store (AWS S3, Cloudflare R2, GCS). The `SavedFile.url` field is already the abstraction point — swap the local `fs.writeFileSync` for a `s3.putObject()` call, and return a CDN URL or presigned URL. The `storedName` field (currently a relative path like `banners/abc-123.jpg`) becomes the S3 object key. The `file_uploads` ledger already stores `storedName` — it becomes the object key in production.

For the ticket PDF flow (`bookingController.ts` reads the banner from local disk), replace `fs.readFileSync(localPath)` with a fetch from object storage (or cache the banner bytes in memory/CDN at startup).

**Effort:** ~2–4 hours. Zero breaking changes to the API or database schema.

---

## 3. Custom Image Dimension Parser — TEMPORARY

**File:** `src/utils/imageDimensions.ts`

**What's happening now:** A ~120-line hand-rolled parser for PNG (IHDR chunk), JPEG (SOF0/SOF2 scan), and WebP (VP8/VP8L/VP8X). Written to avoid the `image-size` npm package, which was blocked by npm registry 403 during initial development.

**Why it's temporary:**
- JPEG coverage is incomplete — only handles SOF0 (baseline) and SOF2 (progressive). Misses SOF1 (extended sequential), SOF3 (lossless), and differential variants.
- No EXIF orientation handling — a photo taken on a phone rotated 90° will report swapped width/height.
- WebP parsing is minimal — animated WebP isn't handled.
- No AVIF support.

**Production replacement:** Install `image-size` (`npm install image-size`). Its API is a drop-in replacement for `getImageDimensions()` — same `(buf: Buffer) => { width: number; height: number } | null` signature. Delete `src/utils/imageDimensions.ts` and update the single import in `uploadService.ts`.

**Effort:** 15 minutes.

---

## 4. No Upload-Specific Rate Limiting — WEAK

**File:** `src/middleware/upload.ts` (no limiter), `src/middleware/rateLimiter.ts`

**What's happening now:** The `apiRateLimiter` (30 req/min per IP) covers upload routes. This is permissive for an endpoint that accepts up to 10 MB per request — a single admin could upload 300 MB/minute, or a bad actor could DDoS the disk/network with large uploads.

**Why it's temporary:** The general API limiter doesn't account for the high cost of uploads. Each upload triggers: base64 decode, magic-byte MIME detection, dimension parsing, UUID generation, disk write, database insert.

**Production replacement:** Apply a tighter limiter on upload routes specifically. The existing `rateLimiter()` utility in `rateLimiter.ts` uses the same interface as `express-rate-limit`, so switching is trivial:

```ts
// In uploadRoutes.ts:
import { uploadRateLimiter } from '../middleware/rateLimiter';
router.post('/', uploadRateLimiter, jsonUploadMiddleware, uploadBannerImage);
```

Recommended settings: 10 uploads/minute per admin identity (once multer is in place, key by admin ID instead of IP).

---

## What's Already Production-Ready

- **Database layer** — Parameterised queries everywhere, `withTransaction` for atomic banner activation, partial unique index enforcing single-active ticket ad, soft-delete on all tables.
- **RBAC** — All upload/banner endpoints behind `adminAuthMiddleware`. Moderator+ role required.
- **Image validation** — Magic-byte MIME detection (not trusting client headers), size limits, dimension checks. All enforced server-side.
- **PDF ticket banner** — Renders the active ticket advertisement at the bottom of each ticket. Silent failure if the image can't be read (promotional, not critical).
- **Audit trail** — `file_uploads` ledger records every upload with admin ID, timestamps, dimensions.
- **TypeScript** — Zero build errors, strict mode.

---

## Recommended Priority

| # | Item | Priority | Effort | Blocks prod? |
|---|------|----------|--------|-------------|
| 2 | Local filesystem → S3 | High | 2–4 h | Yes (ephemeral infra) |
| 1 | Base64 JSON → multer | High | ~1 h | No (works now) |
| 4 | Upload rate limiter | Medium | ~30 min | No |
| 3 | Custom dim parser → image-size | Low | 15 min | No |

Items 1 and 3 can be done together in a single pass. Item 2 is the only one that genuinely blocks a production deploy on ephemeral infrastructure (Render, Fly.io, etc.).
