// One-off utility: strips the baked-in white/near-white background from the
// extension icon PNGs and replaces it with real alpha transparency, so the
// icon doesn't show a white square in dark mode.
const fs = require('fs');
const zlib = require('zlib');
const path = require('path');

const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      t[n] = c >>> 0;
    }
    return t;
  })());
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function readChunks(buf) {
  let offset = 8;
  const chunks = [];
  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + length);
    chunks.push({ type, data });
    offset += 12 + length;
  }
  return chunks;
}

function writeChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function unfilter(raw, width, height, bpp) {
  const stride = width * bpp;
  const out = Buffer.alloc(height * stride);
  let rawOff = 0;
  for (let y = 0; y < height; y++) {
    const filterType = raw[rawOff];
    rawOff += 1;
    const rowStart = y * stride;
    const prevRowStart = (y - 1) * stride;
    for (let x = 0; x < stride; x++) {
      const rawByte = raw[rawOff + x];
      const a = x >= bpp ? out[rowStart + x - bpp] : 0;
      const b = y > 0 ? out[prevRowStart + x] : 0;
      const c = y > 0 && x >= bpp ? out[prevRowStart + x - bpp] : 0;
      let val;
      switch (filterType) {
        case 0: val = rawByte; break;
        case 1: val = rawByte + a; break;
        case 2: val = rawByte + b; break;
        case 3: val = rawByte + Math.floor((a + b) / 2); break;
        case 4: val = rawByte + paeth(a, b, c); break;
        default: throw new Error('Unknown filter type ' + filterType);
      }
      out[rowStart + x] = val & 0xff;
    }
    rawOff += stride;
  }
  return out;
}

function refilterNone(pixels, width, height, bpp) {
  const stride = width * bpp;
  const out = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    out[y * (stride + 1)] = 0; // filter type "None"
    pixels.copy(out, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  return out;
}

function processFile(filePath, { edgeFeather = true } = {}) {
  const buf = fs.readFileSync(filePath);
  if (!buf.subarray(0, 8).equals(PNG_SIG)) throw new Error('Not a PNG: ' + filePath);
  const chunks = readChunks(buf);

  const ihdr = chunks.find(c => c.type === 'IHDR').data;
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const bitDepth = ihdr.readUInt8(8);
  const colorType = ihdr.readUInt8(9);

  if (bitDepth !== 8) throw new Error('Only 8-bit PNGs supported, got ' + bitDepth);

  let bpp, hasAlpha, isPalette = false, palette = null, paletteAlpha = null;
  if (colorType === 6) { bpp = 4; hasAlpha = true; }
  else if (colorType === 2) { bpp = 3; hasAlpha = false; }
  else if (colorType === 3) {
    bpp = 1;
    isPalette = true;
    const plte = chunks.find(c => c.type === 'PLTE').data;
    palette = plte;
    const trns = chunks.find(c => c.type === 'tRNS');
    paletteAlpha = trns ? trns.data : null;
  }
  else throw new Error('Unsupported color type ' + colorType + ' (expected RGB, RGBA, or palette)');

  const idatData = Buffer.concat(chunks.filter(c => c.type === 'IDAT').map(c => c.data));
  const raw = zlib.inflateSync(idatData);
  const pixels = unfilter(raw, width, height, bpp);

  // Output is always RGBA
  const outBpp = 4;
  const outPixels = Buffer.alloc(width * height * outBpp);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const srcOff = (y * width + x) * bpp;
      const dstOff = (y * width + x) * outBpp;
      let r, g, b, srcA;
      if (isPalette) {
        const idx = pixels[srcOff];
        r = palette[idx * 3];
        g = palette[idx * 3 + 1];
        b = palette[idx * 3 + 2];
        srcA = paletteAlpha && idx < paletteAlpha.length ? paletteAlpha[idx] : 255;
      } else {
        r = pixels[srcOff];
        g = pixels[srcOff + 1];
        b = pixels[srcOff + 2];
        srcA = hasAlpha ? pixels[srcOff + 3] : 255;
      }

      // The card backdrop (white fill + a faint semi-transparent gray stroke)
      // is achromatic (R≈G≈B); the eye glyph is blue/navy and clearly
      // saturated. Drop achromatic pixels that are either light or already
      // mostly transparent, and feather the anti-aliased blend band between
      // glyph and backdrop so we don't leave a hard-edged halo.
      const minC = Math.min(r, g, b);
      const maxC = Math.max(r, g, b);
      const delta = maxC - minC;
      let alpha;
      if (delta < 12 && (minC > 150 || srcA < 150)) {
        alpha = 0;
      } else if (edgeFeather && delta < 55 && minC > 100) {
        alpha = Math.round((Math.min(1, Math.max(0, (delta - 12) / (55 - 12)))) * 255);
      } else {
        alpha = 255;
      }
      alpha = Math.min(alpha, srcA);

      outPixels[dstOff] = r;
      outPixels[dstOff + 1] = g;
      outPixels[dstOff + 2] = b;
      outPixels[dstOff + 3] = alpha;
    }
  }

  const filtered = refilterNone(outPixels, width, height, outBpp);
  const newIdat = zlib.deflateSync(filtered, { level: 9 });

  const newIhdr = Buffer.alloc(13);
  newIhdr.writeUInt32BE(width, 0);
  newIhdr.writeUInt32BE(height, 4);
  newIhdr.writeUInt8(8, 8);
  newIhdr.writeUInt8(6, 9); // RGBA
  newIhdr.writeUInt8(0, 10);
  newIhdr.writeUInt8(0, 11);
  newIhdr.writeUInt8(0, 12);

  const out = Buffer.concat([
    PNG_SIG,
    writeChunk('IHDR', newIhdr),
    writeChunk('IDAT', newIdat),
    writeChunk('IEND', Buffer.alloc(0)),
  ]);

  fs.writeFileSync(filePath, out);
  console.log('Processed', filePath, `(${width}x${height})`);
}

const targets = process.argv.slice(2);
if (targets.length === 0) {
  console.error('Usage: node make-icon-transparent.js <file.png> [file2.png ...]');
  process.exit(1);
}
for (const t of targets) {
  processFile(path.resolve(t));
}
