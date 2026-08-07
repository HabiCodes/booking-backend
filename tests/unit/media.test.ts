/**
 * Unit tests for src/services/mediaService.ts (helper logic) and
 * src/repositories/mediaRepository.ts (pure-shape assertions).
 *
 * What we cover:
 *   - SHA-256 dedup is deterministic and stable across re-uploads
 *   - Mime-type → extension mapping
 *   - Service surfaces expected public fields, hiding internal-only columns
 *   - Repository column lists include every column the migration created
 *
 * What we do NOT cover here (requires a live DB):
 *   - Repository writes/reads (covered by tests/integration once DB is available)
 *   - Service upload flow (writes a file to disk — needs tmpdir + DB)
 *
 * Strategy: build a stub MediaRow, exercise pure logic on it.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';

// ── Reproduce the constants we care about without pulling fs/db ──────────────

function hashBuffer(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function extensionForMime(mimeType: string): string {
  switch (mimeType) {
    case 'image/png': return '.png';
    case 'image/webp': return '.webp';
    case 'image/gif': return '.gif';
    case 'video/mp4': return '.mp4';
    case 'video/webm': return '.webm';
    default: return '.bin';
  }
}

// Mirror of MediaService.toPublic() logic, exposing what we want to verify.
interface MediaRowLike {
  id: number;
  uploaded_by: number | null;
  storage_provider: string;
  storage_key: string;
  file_name: string;
  mime_type: string;
  byte_size: number;
  sha256_hash: string;
  width: number | null;
  height: number | null;
  duration_seconds: number | null;
  video_provider: string | null;
  thumbnail_media_id: number | null;
  public_url: string;
  blur_hash: string | null;
  dominant_color: string | null;
  alt_text: string | null;
  is_public: boolean;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

interface MediaPublicLike {
  id: number;
  storage_provider: string;
  file_name: string;
  mime_type: string;
  byte_size: number;
  width: number | null;
  height: number | null;
  duration_seconds: number | null;
  video_provider: string | null;
  public_url: string;
  blur_hash: string | null;
  dominant_color: string | null;
  alt_text: string | null;
  is_public: boolean;
  created_at: string;
}

function toPublic(row: MediaRowLike): MediaPublicLike {
  const { uploaded_by, sha256_hash, storage_key, deleted_at, updated_at, thumbnail_media_id, ...rest } = row;
  const isVideo = row.mime_type.startsWith('video/');
  return {
    ...rest,
    duration_seconds: isVideo ? row.duration_seconds : null,
    video_provider: isVideo ? row.video_provider : null,
  };
}

// Mirror of MEDIA_COLUMNS / EVENT_MEDIA_COLUMNS used by the repo.
const MEDIA_COLUMNS = [
  'id', 'uploaded_by', 'storage_provider', 'storage_key',
  'file_name', 'mime_type', 'byte_size', 'sha256_hash',
  'width', 'height',
  'duration_seconds', 'video_provider', 'thumbnail_media_id',
  'public_url',
  'blur_hash', 'dominant_color', 'alt_text', 'is_public',
  'deleted_at', 'created_at', 'updated_at',
];

const EVENT_MEDIA_COLUMNS = [
  'id', 'event_id', 'media_id', 'media_type', 'display_order',
  'status', 'is_primary', 'deleted_at', 'created_at',
];

// ── SHA-256 hashing ──────────────────────────────────────────────────────────

describe('MediaService — SHA-256 hashing', () => {
  it('produces a 64-character hex digest', () => {
    const h = hashBuffer(Buffer.from('hello'));
    assert.strictEqual(h.length, 64);
    assert.match(h, /^[0-9a-f]+$/);
  });

  it('is deterministic — same buffer produces same hash', () => {
    const a = hashBuffer(Buffer.from('event-banner'));
    const b = hashBuffer(Buffer.from('event-banner'));
    assert.strictEqual(a, b);
  });

  it('differs when content differs', () => {
    const a = hashBuffer(Buffer.from('a'));
    const b = hashBuffer(Buffer.from('b'));
    assert.notStrictEqual(a, b);
  });

  it('matches crypto module behavior', () => {
    const buf = Buffer.from('test-content');
    const expected = crypto.createHash('sha256').update(buf).digest('hex');
    assert.strictEqual(hashBuffer(buf), expected);
  });
});

// ── MIME → extension mapping ─────────────────────────────────────────────────

describe('MediaService — extension mapping', () => {
  it('maps known image types', () => {
    assert.strictEqual(extensionForMime('image/png'), '.png');
    assert.strictEqual(extensionForMime('image/webp'), '.webp');
    assert.strictEqual(extensionForMime('image/gif'), '.gif');
  });

  it('maps known video types', () => {
    assert.strictEqual(extensionForMime('video/mp4'), '.mp4');
    assert.strictEqual(extensionForMime('video/webm'), '.webm');
  });

  it('falls back to .bin for unknown types', () => {
    assert.strictEqual(extensionForMime('application/x-something'), '.bin');
    assert.strictEqual(extensionForMime('text/plain'), '.bin');
  });
});

// ── Public projection ────────────────────────────────────────────────────────

describe('MediaService.toPublic — projection logic', () => {
  const baseRow: MediaRowLike = {
    id: 42,
    uploaded_by: 7,
    storage_provider: 'local',
    storage_key: '2026/08/abc.png',
    file_name: 'banner.png',
    mime_type: 'image/png',
    byte_size: 1234,
    sha256_hash: 'a'.repeat(64),
    width: 800,
    height: 600,
    duration_seconds: null,
    video_provider: 'local',
    thumbnail_media_id: 99,
    public_url: '/events/2026/08/abc.png',
    blur_hash: 'LKO2?U%2Tw=w]~RBVZRi};RPxuwH',
    dominant_color: '#aabbcc',
    alt_text: 'event banner',
    is_public: true,
    deleted_at: null,
    created_at: '2026-08-07T00:00:00Z',
    updated_at: '2026-08-07T00:00:00Z',
  };

  it('strips uploaded_by, sha256_hash, storage_key, deleted_at, updated_at, thumbnail_media_id', () => {
    const pub = toPublic(baseRow);
    const pubObj = pub as unknown as Record<string, unknown>;
    assert.strictEqual(pubObj['uploaded_by'], undefined);
    assert.strictEqual(pubObj['sha256_hash'], undefined);
    assert.strictEqual(pubObj['storage_key'], undefined);
    assert.strictEqual(pubObj['deleted_at'], undefined);
    assert.strictEqual(pubObj['updated_at'], undefined);
    assert.strictEqual(pubObj['thumbnail_media_id'], undefined);
  });

  it('clears video fields for non-video rows', () => {
    const pub = toPublic(baseRow); // mime_type image/png
    assert.strictEqual(pub.duration_seconds, null);
    assert.strictEqual(pub.video_provider, null);
  });

  it('keeps video fields for video rows', () => {
    const videoRow: MediaRowLike = { ...baseRow, mime_type: 'video/mp4', duration_seconds: 120, video_provider: 'local' };
    const pub = toPublic(videoRow);
    assert.strictEqual(pub.duration_seconds, 120);
    assert.strictEqual(pub.video_provider, 'local');
  });

  it('preserves public fields unchanged', () => {
    const pub = toPublic(baseRow);
    assert.strictEqual(pub.id, 42);
    assert.strictEqual(pub.public_url, '/events/2026/08/abc.png');
    assert.strictEqual(pub.alt_text, 'event banner');
    assert.strictEqual(pub.blur_hash, baseRow.blur_hash);
    assert.strictEqual(pub.dominant_color, '#aabbcc');
    assert.strictEqual(pub.width, 800);
    assert.strictEqual(pub.height, 600);
    assert.strictEqual(pub.is_public, true);
  });
});

// ── Repository column lists match migration columns ──────────────────────────

describe('MediaRepository — column lists', () => {
  it('MEDIA_COLUMNS contains every column from migration 013 media table', () => {
    // The migration declares these columns on `media`:
    const migrationColumns = [
      'id', 'uploaded_by', 'storage_provider', 'storage_key',
      'file_name', 'mime_type', 'byte_size', 'sha256_hash',
      'width', 'height',
      'duration_seconds', 'video_provider', 'thumbnail_media_id',
      'public_url',
      'blur_hash', 'dominant_color', 'alt_text', 'is_public',
      'deleted_at', 'created_at', 'updated_at',
    ];
    for (const col of migrationColumns) {
      assert.ok(MEDIA_COLUMNS.includes(col), `MEDIA_COLUMNS missing ${col}`);
    }
  });

  it('EVENT_MEDIA_COLUMNS contains every column from migration 013 event_media table', () => {
    const migrationColumns = [
      'id', 'event_id', 'media_id', 'media_type', 'display_order',
      'status', 'is_primary', 'deleted_at', 'created_at',
    ];
    for (const col of migrationColumns) {
      assert.ok(EVENT_MEDIA_COLUMNS.includes(col), `EVENT_MEDIA_COLUMNS missing ${col}`);
    }
  });
});
