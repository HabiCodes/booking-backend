/**
 * Unit tests for src/utils/imageDimensions.ts
 *
 * Covers the dimension detection for PNG, JPEG, and WebP buffers.
 * These are pure-file-format parsers — no external deps required.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { getImageDimensions } from '../../src/utils/imageDimensions';

/**
 * Build a minimal PNG buffer with the given width/height.
 * Header: 8-byte signature + IHDR chunk (length=13, "IHDR", width, height, etc.)
 */
function buildPng(width: number, height: number): Buffer {
  const buf = Buffer.alloc(24);
  // PNG signature
  buf[0] = 0x89; buf[1] = 0x50; buf[2] = 0x4e; buf[3] = 0x47;
  buf[4] = 0x0d; buf[5] = 0x0a; buf[6] = 0x1a; buf[7] = 0x0a;
  // IHDR length (4 bytes BE) = 13
  buf[8] = 0; buf[9] = 0; buf[10] = 0; buf[11] = 13;
  // "IHDR" type
  buf[12] = 0x49; buf[13] = 0x48; buf[14] = 0x44; buf[15] = 0x52;
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
function buildJpeg(width: number, height: number): Buffer {
  // Need enough bytes for the full SOF0 segment to be parsed
  const buf = Buffer.alloc(16);
  buf[0] = 0xff; buf[1] = 0xd8; // SOI
  buf[2] = 0xff; buf[3] = 0xc0; // SOF0 marker
  buf[4] = 0x00; buf[5] = 0x0b; // length = 11 bytes
  buf[6] = 0x08;                  // precision
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

describe('imageDimensions', () => {
  describe('getImageDimensions', () => {
    it('parses PNG width/height', () => {
      const dims = getImageDimensions(buildPng(1600, 400));
      assert.deepStrictEqual(dims, { width: 1600, height: 400 });
    });

    it('parses JPEG width/height', () => {
      const dims = getImageDimensions(buildJpeg(800, 600));
      assert.deepStrictEqual(dims, { width: 800, height: 600 });
    });

    it('returns null for a non-image buffer', () => {
      const buf = Buffer.from('not an image at all — just text');
      assert.strictEqual(getImageDimensions(buf), null);
    });

    it('returns null for an empty buffer', () => {
      const buf = Buffer.alloc(0);
      assert.strictEqual(getImageDimensions(buf), null);
    });

    it('returns null for a too-small buffer (no signature)', () => {
      const buf = Buffer.from([0xff, 0xd8]);
      assert.strictEqual(getImageDimensions(buf), null);
    });

    it('returns null for a WebP buffer without VP8/VP8L/VP8X chunk', () => {
      // Minimal RIFF/WEBP header but no chunk
      const buf = Buffer.alloc(16);
      buf.write('RIFF', 0, 'ascii');
      buf.write('WEBP', 8, 'ascii');
      assert.strictEqual(getImageDimensions(buf), null);
    });

    it('rejects absurdly large dimensions (sanity check)', () => {
      const buf = buildPng(99999, 99999);
      assert.strictEqual(getImageDimensions(buf), null);
    });
  });
});