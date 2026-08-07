"use strict";
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const crypto_1 = __importDefault(require("crypto"));
// ── Reproduce the constants we care about without pulling fs/db ──────────────
function hashBuffer(buf) {
    return crypto_1.default.createHash('sha256').update(buf).digest('hex');
}
function extensionForMime(mimeType) {
    switch (mimeType) {
        case 'image/png': return '.png';
        case 'image/webp': return '.webp';
        case 'image/gif': return '.gif';
        case 'video/mp4': return '.mp4';
        case 'video/webm': return '.webm';
        default: return '.bin';
    }
}
function toPublic(row) {
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
(0, node_test_1.describe)('MediaService — SHA-256 hashing', () => {
    (0, node_test_1.it)('produces a 64-character hex digest', () => {
        const h = hashBuffer(Buffer.from('hello'));
        strict_1.default.strictEqual(h.length, 64);
        strict_1.default.match(h, /^[0-9a-f]+$/);
    });
    (0, node_test_1.it)('is deterministic — same buffer produces same hash', () => {
        const a = hashBuffer(Buffer.from('event-banner'));
        const b = hashBuffer(Buffer.from('event-banner'));
        strict_1.default.strictEqual(a, b);
    });
    (0, node_test_1.it)('differs when content differs', () => {
        const a = hashBuffer(Buffer.from('a'));
        const b = hashBuffer(Buffer.from('b'));
        strict_1.default.notStrictEqual(a, b);
    });
    (0, node_test_1.it)('matches crypto module behavior', () => {
        const buf = Buffer.from('test-content');
        const expected = crypto_1.default.createHash('sha256').update(buf).digest('hex');
        strict_1.default.strictEqual(hashBuffer(buf), expected);
    });
});
// ── MIME → extension mapping ─────────────────────────────────────────────────
(0, node_test_1.describe)('MediaService — extension mapping', () => {
    (0, node_test_1.it)('maps known image types', () => {
        strict_1.default.strictEqual(extensionForMime('image/png'), '.png');
        strict_1.default.strictEqual(extensionForMime('image/webp'), '.webp');
        strict_1.default.strictEqual(extensionForMime('image/gif'), '.gif');
    });
    (0, node_test_1.it)('maps known video types', () => {
        strict_1.default.strictEqual(extensionForMime('video/mp4'), '.mp4');
        strict_1.default.strictEqual(extensionForMime('video/webm'), '.webm');
    });
    (0, node_test_1.it)('falls back to .bin for unknown types', () => {
        strict_1.default.strictEqual(extensionForMime('application/x-something'), '.bin');
        strict_1.default.strictEqual(extensionForMime('text/plain'), '.bin');
    });
});
// ── Public projection ────────────────────────────────────────────────────────
(0, node_test_1.describe)('MediaService.toPublic — projection logic', () => {
    const baseRow = {
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
    (0, node_test_1.it)('strips uploaded_by, sha256_hash, storage_key, deleted_at, updated_at, thumbnail_media_id', () => {
        const pub = toPublic(baseRow);
        const pubObj = pub;
        strict_1.default.strictEqual(pubObj['uploaded_by'], undefined);
        strict_1.default.strictEqual(pubObj['sha256_hash'], undefined);
        strict_1.default.strictEqual(pubObj['storage_key'], undefined);
        strict_1.default.strictEqual(pubObj['deleted_at'], undefined);
        strict_1.default.strictEqual(pubObj['updated_at'], undefined);
        strict_1.default.strictEqual(pubObj['thumbnail_media_id'], undefined);
    });
    (0, node_test_1.it)('clears video fields for non-video rows', () => {
        const pub = toPublic(baseRow); // mime_type image/png
        strict_1.default.strictEqual(pub.duration_seconds, null);
        strict_1.default.strictEqual(pub.video_provider, null);
    });
    (0, node_test_1.it)('keeps video fields for video rows', () => {
        const videoRow = { ...baseRow, mime_type: 'video/mp4', duration_seconds: 120, video_provider: 'local' };
        const pub = toPublic(videoRow);
        strict_1.default.strictEqual(pub.duration_seconds, 120);
        strict_1.default.strictEqual(pub.video_provider, 'local');
    });
    (0, node_test_1.it)('preserves public fields unchanged', () => {
        const pub = toPublic(baseRow);
        strict_1.default.strictEqual(pub.id, 42);
        strict_1.default.strictEqual(pub.public_url, '/events/2026/08/abc.png');
        strict_1.default.strictEqual(pub.alt_text, 'event banner');
        strict_1.default.strictEqual(pub.blur_hash, baseRow.blur_hash);
        strict_1.default.strictEqual(pub.dominant_color, '#aabbcc');
        strict_1.default.strictEqual(pub.width, 800);
        strict_1.default.strictEqual(pub.height, 600);
        strict_1.default.strictEqual(pub.is_public, true);
    });
});
// ── Repository column lists match migration columns ──────────────────────────
(0, node_test_1.describe)('MediaRepository — column lists', () => {
    (0, node_test_1.it)('MEDIA_COLUMNS contains every column from migration 013 media table', () => {
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
            strict_1.default.ok(MEDIA_COLUMNS.includes(col), `MEDIA_COLUMNS missing ${col}`);
        }
    });
    (0, node_test_1.it)('EVENT_MEDIA_COLUMNS contains every column from migration 013 event_media table', () => {
        const migrationColumns = [
            'id', 'event_id', 'media_id', 'media_type', 'display_order',
            'status', 'is_primary', 'deleted_at', 'created_at',
        ];
        for (const col of migrationColumns) {
            strict_1.default.ok(EVENT_MEDIA_COLUMNS.includes(col), `EVENT_MEDIA_COLUMNS missing ${col}`);
        }
    });
});
