/**
 * Detect image width/height from a Buffer without external dependencies.
 * Supports PNG, JPEG (baseline + progressive), and WebP.
 */

/**
 * Read a 4-byte big-endian u32 from buffer at offset.
 */
function readU32BE(buf: Buffer, offset: number): number {
  return (buf[offset] << 24) | (buf[offset + 1] << 16) | (buf[offset + 2] << 8) | buf[offset + 3];
}

/**
 * PNG: IHDR chunk is always at offset 12 (after 8-byte signature + 8-byte IHDR header).
 *   Offset 12: length (4), type "IHDR" (4), then width (4), height (4)
 */
function readPngDimensions(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 24) return null;
  // Validate PNG signature
  if (buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) return null;
  const width = readU32BE(buf, 16);
  const height = readU32BE(buf, 20);
  if (width <= 0 || height <= 0 || width > 10000 || height > 10000) return null;
  return { width, height };
}

/**
 * JPEG: Scan for SOF0 (0xFFC0) or SOF2 (0xFFC2) marker.
 *   Each segment: FF marker (2 bytes), length (2 bytes), then data.
 *   SOF segments: length (2), precision (1), height (2), width (2).
 */
function readJpegDimensions(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;

  let offset = 2;
  while (offset < buf.length - 1) {
    // Find next marker (0xFF followed by non-FF byte)
    if (buf[offset] !== 0xff) return null;
    let marker = buf[offset + 1];
    if (marker === 0xff) { offset++; continue; }

    // Handle standalone markers (no length field)
    if (marker === 0xd8 || marker === 0xd9) {
      offset += 2;
      continue;
    }

    if (offset + 3 >= buf.length) return null;
    const segLen = (buf[offset + 2] << 8) | buf[offset + 3];
    if (segLen < 2 || offset + 2 + segLen > buf.length) return null;
    // Need at least 9 bytes from offset (margin check for SOF reads at offset+4..8)
    if (offset + 9 > buf.length) return null;

    // SOF0 (baseline), SOF1 (extended sequential), SOF2 (progressive)
    if (
      marker === 0xc0 ||
      marker === 0xc1 ||
      marker === 0xc2
    ) {
      // SOF layout after marker+length (offset+2 segLen, offset+4 precision):
      //   offset+4: precision (1 byte), offset+5: height HI, offset+6: height LO,
      //   offset+7: width HI,  offset+8: width LO
      const height = (buf[offset + 5] << 8) | buf[offset + 6];
      const width = (buf[offset + 7] << 8) | buf[offset + 8];
      if (width > 0 && height > 0 && width <= 10000 && height <= 10000) {
        return { width, height };
      }
      return null;
    }

    offset += 2 + segLen;
  }

  return null;
}

/**
 * WebP: Parse RIFF header, then VP8/VP8L/VP8X chunk.
 *   VP8 (lossy):   after "VP8 " chunk header (10 bytes), 3-byte frame tag, then 2-byte width, 2-byte height
 *   VP8L (lossless): after "VP8L" chunk (10 bytes), 1-byte signature, then 4-byte size (14-bit width + 14-bit height)
 *   VP8X (extended): after "VP8X" chunk (10 bytes), 1-byte width + 2-byte height (little-endian, +1 each)
 */
function readWebpDimensions(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 30) return null;

  // Validate "RIFF" + "WEBP"
  if (
    buf[0] !== 0x52 || buf[1] !== 0x49 || buf[2] !== 0x46 || buf[3] !== 0x46 || // RIFF
    buf[8] !== 0x57 || buf[9] !== 0x45 || buf[10] !== 0x42 || buf[11] !== 0x50 // WEBP
  ) {
    return null;
  }

  // Look for VP8, VP8L, or VP8X chunk
  let offset = 12;
  while (offset < buf.length - 8) {
    const fourCC = buf.slice(offset, offset + 4).toString('ascii');
    const chunkSize = readU32BE(buf, offset + 4);
    const chunkDataStart = offset + 8;
    const chunkDataEnd = chunkDataStart + chunkSize;

    if (fourCC === 'VP8 ' && chunkSize >= 10) {
      // Lossy: 3-byte frame tag, then 2-byte width, 2-byte height (little-endian)
      const width = buf[chunkDataStart + 6] | (buf[chunkDataStart + 7] << 8);
      const height = buf[chunkDataStart + 8] | (buf[chunkDataStart + 9] << 8);
      if (width > 0 && height > 0 && width <= 10000 && height <= 10000) {
        return { width, height };
      }
      return null;
    }

    if (fourCC === 'VP8L' && chunkSize >= 5) {
      // Lossless: 1-byte signature (0x2f), then 4-byte size (14-bit width + 14-bit height)
      const bits = readU32BE(buf, chunkDataStart + 1);
      const width = (bits & 0x3fff) + 1;
      const height = ((bits >> 14) & 0x3fff) + 1;
      if (width > 0 && height > 0 && width <= 10000 && height <= 10000) {
        return { width, height };
      }
      return null;
    }

    if (fourCC === 'VP8X' && chunkSize >= 10) {
      // Extended: width is 3 bytes little-endian at offset+6, height at offset+9
      const width =
        buf[chunkDataStart + 6] |
        (buf[chunkDataStart + 7] << 8) |
        (buf[chunkDataStart + 8] << 16);
      const height =
        buf[chunkDataStart + 9] |
        (buf[chunkDataStart + 10] << 8) |
        (buf[chunkDataStart + 11] << 16);
      if (width > 0 && height > 0 && width <= 10000 && height <= 10000) {
        return { width, height };
      }
      return null;
    }

    // Move to next chunk (padded to 2-byte boundary)
    const padded = (chunkSize + 1) & ~1;
    offset = chunkDataStart + padded;
  }

  return null;
}

export function getImageDimensions(buf: Buffer): { width: number; height: number } | null {
  if (buf.length < 16) return null;

  // Detect format from magic bytes
  const isPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  const isJpeg = buf[0] === 0xff && buf[1] === 0xd8;
  const isWebp =
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50;

  if (isPng) return readPngDimensions(buf);
  if (isJpeg) return readJpegDimensions(buf);
  if (isWebp) return readWebpDimensions(buf);

  return null;
}