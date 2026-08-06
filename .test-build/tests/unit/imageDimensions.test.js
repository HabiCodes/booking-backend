"use strict";
/**
 * Unit tests for src/utils/imageDimensions.ts
 *
 * Covers the dimension detection for PNG, JPEG, and WebP buffers.
 * These are pure-file-format parsers — no external deps required.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const node_test_1 = require("node:test");
const strict_1 = __importDefault(require("node:assert/strict"));
const imageDimensions_1 = require("../../src/utils/imageDimensions");
/**
 * Build a minimal PNG buffer with the given width/height.
 * Header: 8-byte signature + IHDR chunk (length=13, "IHDR", width, height, etc.)
 */
function buildPng(width, height) {
    const buf = Buffer.alloc(24);
    // PNG signature
    buf[0] = 0x89;
    buf[1] = 0x50;
    buf[2] = 0x4e;
    buf[3] = 0x47;
    buf[4] = 0x0d;
    buf[5] = 0x0a;
    buf[6] = 0x1a;
    buf[7] = 0x0a;
    // IHDR length (4 bytes BE) = 13
    buf[8] = 0;
    buf[9] = 0;
    buf[10] = 0;
    buf[11] = 13;
    // "IHDR" type
    buf[12] = 0x49;
    buf[13] = 0x48;
    buf[14] = 0x44;
    buf[15] = 0x52;
    // Width (4 bytes BE)
    buf[16] = (width >>> 24) & 0xff;
    buf[17] = (width >>> 16) & 0xff;
    buf[18] = (width >>> 8) & 0xff;
    buf[19] = width & 0xff;
    // Height (4 bytes BE)
    buf[20] = (height >>> 24) & 0xff;
    buf[21] = (height >>> 16) & 0xff;
    buf[22] = (height >>> 8) & 0xff;
    buf[23] = height & 0xff;
    return buf;
}
/**
 * Build a minimal JPEG with a SOF0 segment.
 *   FF D8             (SOI)
 *   FF C0 00 0B 08    (SOF0: length=11, precision=8)
 *   HH HH WW WW ...   (height, width, components)
 */
function buildJpeg(width, height) {
    // Need enough bytes for the full SOF0 segment to be parsed
    const buf = Buffer.alloc(16);
    buf[0] = 0xff;
    buf[1] = 0xd8; // SOI
    buf[2] = 0xff;
    buf[3] = 0xc0; // SOF0 marker
    buf[4] = 0x00;
    buf[5] = 0x0b; // length = 11 bytes
    buf[6] = 0x08; // precision
    buf[7] = (height >> 8) & 0xff;
    buf[8] = height & 0xff;
    buf[9] = (width >> 8) & 0xff;
    buf[10] = width & 0xff;
    // Fill remaining component bytes so segLen check passes
    buf[11] = 0x01; // components = 1 (grayscale)
    buf[12] = 0x11; // component 1: sampling + quant table
    buf[13] = 0x00;
    buf[14] = 0x3f; // dummy Huffman table
    buf[15] = 0x00;
    return buf;
}
(0, node_test_1.describe)('imageDimensions', () => {
    (0, node_test_1.describe)('getImageDimensions', () => {
        (0, node_test_1.it)('parses PNG width/height', () => {
            const dims = (0, imageDimensions_1.getImageDimensions)(buildPng(1600, 400));
            strict_1.default.deepStrictEqual(dims, { width: 1600, height: 400 });
        });
        (0, node_test_1.it)('parses JPEG width/height', () => {
            const dims = (0, imageDimensions_1.getImageDimensions)(buildJpeg(800, 600));
            strict_1.default.deepStrictEqual(dims, { width: 800, height: 600 });
        });
        (0, node_test_1.it)('returns null for a non-image buffer', () => {
            const buf = Buffer.from('not an image at all — just text');
            strict_1.default.strictEqual((0, imageDimensions_1.getImageDimensions)(buf), null);
        });
        (0, node_test_1.it)('returns null for an empty buffer', () => {
            const buf = Buffer.alloc(0);
            strict_1.default.strictEqual((0, imageDimensions_1.getImageDimensions)(buf), null);
        });
        (0, node_test_1.it)('returns null for a too-small buffer (no signature)', () => {
            const buf = Buffer.from([0xff, 0xd8]);
            strict_1.default.strictEqual((0, imageDimensions_1.getImageDimensions)(buf), null);
        });
        (0, node_test_1.it)('returns null for a WebP buffer without VP8/VP8L/VP8X chunk', () => {
            // Minimal RIFF/WEBP header but no chunk
            const buf = Buffer.alloc(16);
            buf.write('RIFF', 0, 'ascii');
            buf.write('WEBP', 8, 'ascii');
            strict_1.default.strictEqual((0, imageDimensions_1.getImageDimensions)(buf), null);
        });
        (0, node_test_1.it)('rejects absurdly large dimensions (sanity check)', () => {
            const buf = buildPng(99999, 99999);
            strict_1.default.strictEqual((0, imageDimensions_1.getImageDimensions)(buf), null);
        });
    });
});
