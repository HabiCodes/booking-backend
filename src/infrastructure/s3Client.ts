/**
 * Native S3 client using Node.js built-in `https` + `crypto`.
 * Implements SigV4 signing — no external AWS SDK dependency required.
 *
 * SECURITY DECISION: S3 objects are PRIVATE.
 * Access is via API endpoints that proxy downloads with auth checks.
 * We never expose S3 presigned URLs or make the bucket publicly readable.
 *
 * Rationale:
 *  - Media may contain proprietary content (event posters, movie posters, turf photos, banners)
 *  - Public bucket allows anyone to enumerate/list objects
 *  - Presigned URLs leak temporary access to the bucket
 *  - Our API already has auth (admin/manager JWT) — use it as the gate
 *  - Frontend calls our API -> we validate permissions -> we proxy the file
 */

import https from 'https';
import http from 'http';
import crypto from 'crypto';
import { config } from '../config';
import { logger } from '../utils/logger';

// ── Configuration (lazy — read from centralized config) ───────────────────────

export interface S3Config {
  bucket: string;
  region: string;
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
  publicBaseUrl: string;
}

function resolveConfig(): S3Config {
  const s = config.s3;
  return {
    bucket: s.bucket,
    region: s.region || 'us-east-1',
    endpoint: s.endpoint || 'https://s3.amazonaws.com',
    accessKeyId: s.accessKeyId,
    secretAccessKey: s.secretAccessKey,
    forcePathStyle: s.forcePathStyle,
    publicBaseUrl: s.publicBaseUrl,
  };
}

// ── Internal types ────────────────────────────────────────────────────────────

export interface S3ObjectResult {
  body: Buffer;
  contentType: string;
  contentLength: number;
  lastModified: string;
  etag: string;
}

export interface S3PutResult {
  etag: string;
  versionId?: string;
}

// ── SigV4 Signing ─────────────────────────────────────────────────────────────

function hmac(key: Buffer | string, data: string): Buffer {
  return crypto.createHmac('sha256', key).update(data).digest();
}

function sha256(data: string | Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function getSignatureKey(
  key: string,
  dateStamp: string,
  region: string,
  service: string
): Buffer {
  const kDate = hmac(`AWS4${key}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kSigning = hmac(kRegion, service);
  const kCredentials = hmac(kSigning, 'aws4_request');
  return kCredentials;
}

function createAuthorizationHeader(
  method: string,
  uri: string,
  queryString: string,
  headers: Record<string, string>,
  body: string,
  date: Date,
  s3c: S3Config
): string {
  const algorithm = 'AWS4-HMAC-SHA256';
  const service = 's3';
  const dateStamp = date.toISOString().slice(0, 10).replace(/-/g, '');
  const amzDate = date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const credentialScope = `${dateStamp}/${s3c.region}/${service}/aws4_request`;

  const signedHeadersList: string[] = [];
  const canonicalHeaders: string[] = [];

  const sortedHeaderKeys = Object.keys(headers).sort(
    (a, b) => a.toLowerCase() < b.toLowerCase() ? -1 : 1
  );
  for (const key of sortedHeaderKeys) {
    signedHeadersList.push(key.toLowerCase());
    canonicalHeaders.push(`${key.toLowerCase()}:${headers[key].trim()}`);
  }

  const canonicalHeadersStr = canonicalHeaders.join('\n') + '\n';
  const signedHeaders = signedHeadersList.join(';');

  const payloadHash = sha256(body);
  const canonicalRequest = [
    method,
    uri,
    queryString,
    canonicalHeadersStr,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const stringToSign = [
    algorithm,
    amzDate,
    credentialScope,
    sha256(canonicalRequest),
  ].join('\n');

  const signingKey = getSignatureKey(s3c.secretAccessKey, dateStamp, s3c.region, service);
  const signature = hmac(signingKey, stringToSign).toString('hex');

  const credential = `${s3c.accessKeyId}/${credentialScope}`;
  return `${algorithm} Credential=${credential}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function s3Request(
  method: string,
  objectKey: string,
  body: string | Buffer,
  contentType?: string,
  extraHeaders: Record<string, string> = {}
): Promise<{ statusCode: number; headers: Record<string, string>; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const s3c = resolveConfig();
    const date = new Date();

    let uri: string;
    if (s3c.forcePathStyle) {
      uri = `/${s3c.bucket}/${objectKey}`;
    } else {
      uri = `/${objectKey}`;
    }

    const headers: Record<string, string> = {
      'X-Amz-Date': date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''),
      ...extraHeaders,
    };

    if (contentType) {
      headers['Content-Type'] = contentType;
      headers['x-amz-content-sha256'] = 'UNSIGNED-PAYLOAD';
    }

    // For SigV4 with UNSIGNED-PAYLOAD, body hash is 'UNSIGNED-PAYLOAD'
    // We don't actually hash the body — we just write it as-is
    const bodyStr = typeof body === 'string' ? body : body.toString();
    const authorization = createAuthorizationHeader(
      method, uri, '', headers, bodyStr, date, s3c
    );
    headers['Authorization'] = authorization;

    const host = s3c.forcePathStyle
      ? new URL(s3c.endpoint).hostname
      : `${s3c.bucket}.s3.${s3c.region}.amazonaws.com`;

    const isHttps = s3c.endpoint.startsWith('https');
    const client = isHttps ? https : http;
    const port = new URL(s3c.endpoint).port;

    const options: https.RequestOptions = {
      hostname: host,
      ...(port ? { port: Number(port) } : {}),
      method,
      path: s3c.forcePathStyle ? uri : `/${objectKey}`,
      headers,
    };

    const req = client.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode || 0,
          headers: res.headers as Record<string, string>,
          body: Buffer.concat(chunks),
        });
      });
    });

    req.on('error', reject);
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error('S3 request timeout'));
    });

    // Write binary buffer for uploads
    if (Buffer.isBuffer(body)) {
      req.write(body);
    } else if (body && body.length > 0) {
      req.write(body);
    }
    req.end();
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Upload a buffer to S3.
 * @param key - S3 object key (path-like, no leading slash)
 * @param buf - File content
 * @param contentType - MIME type
 * @returns Upload result with ETag
 */
export async function s3PutObject(
  key: string,
  buf: Buffer,
  contentType: string
): Promise<S3PutResult> {
  const s3c = resolveConfig();
  if (!s3c.bucket) {
    throw new Error('S3 not configured: set S3_BUCKET environment variable');
  }

  const response = await s3Request('PUT', key, buf, contentType);
  if (response.statusCode < 200 || response.statusCode >= 300) {
    const error = response.body.toString();
    logger.error('S3 PUT failed', { status: response.statusCode, key, error: error.slice(0, 500) });
    throw new Error(`S3 upload failed (${response.statusCode}): ${error.slice(0, 500)}`);
  }
  const etag = response.headers['etag']?.replace(/"/g, '') || '';
  return {
    etag,
    versionId: response.headers['x-amz-version-id'] || undefined,
  };
}

/**
 * Download an object from S3.
 * @param key - S3 object key
 * @returns Object body and metadata, or null if not found
 */
export async function s3GetObject(key: string): Promise<S3ObjectResult | null> {
  const s3c = resolveConfig();
  if (!s3c.bucket) {
    throw new Error('S3 not configured: set S3_BUCKET environment variable');
  }

  const response = await s3Request('GET', key, '');
  if (response.statusCode === 404 || response.statusCode === 403) {
    return null;
  }
  if (response.statusCode < 200 || response.statusCode >= 300) {
    const error = response.body.toString();
    logger.error('S3 GET failed', { status: response.statusCode, key, error: error.slice(0, 500) });
    throw new Error(`S3 download failed (${response.statusCode}): ${error.slice(0, 500)}`);
  }
  return {
    body: response.body,
    contentType: response.headers['content-type'] || 'application/octet-stream',
    contentLength: Number(response.headers['content-length'] || response.body.length),
    lastModified: response.headers['last-modified'] || new Date().toISOString(),
    etag: response.headers['etag']?.replace(/"/g, '') || '',
  };
}

/**
 * Delete an object from S3.
 * Idempotent: 404 is treated as success.
 * @param key - S3 object key
 */
export async function s3DeleteObject(key: string): Promise<void> {
  const s3c = resolveConfig();
  if (!s3c.bucket) {
    throw new Error('S3 not configured: set S3_BUCKET environment variable');
  }

  try {
    const response = await s3Request('DELETE', key, '');
    if (response.statusCode !== 204 && response.statusCode !== 404) {
      const error = response.body.toString();
      logger.error('S3 DELETE failed', { status: response.statusCode, key, error: error.slice(0, 500) });
      throw new Error(`S3 delete failed (${response.statusCode}): ${error.slice(0, 500)}`);
    }
  } catch (err) {
    if ((err as Error).message?.includes('404')) {
      return;
    }
    throw err;
  }
}

/**
 * Check if an object exists in S3.
 */
export async function s3ObjectExists(key: string): Promise<boolean> {
  const s3c = resolveConfig();
  if (!s3c.bucket) return false;

  try {
    const result = await s3GetObject(key);
    return result !== null;
  } catch {
    return false;
  }
}

/**
 * Whether S3 is configured and active.
 */
export function isS3Configured(): boolean {
  const s3c = resolveConfig();
  return !!s3c.bucket && !!s3c.accessKeyId && !!s3c.secretAccessKey;
}
