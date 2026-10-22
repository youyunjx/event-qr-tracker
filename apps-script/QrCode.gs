/**
 * Minimal QR Code encoder (byte mode) and 1-bit PNG writer, with no external services.
 *
 * The QR part is a condensed port of Project Nayuki's QR Code generator library
 * (MIT License, https://www.nayuki.io/page/qr-code-generator-library).
 *
 *   qrEncode_(text, 'H')            -> boolean[][] modules (true = dark)
 *   qrToPngBytes_(modules, scale, border) -> number[] PNG file bytes (0..255)
 */

const QR_ECL = { L: 0, M: 1, Q: 2, H: 3 };
const QR_ECL_FORMAT_BITS = [1, 0, 3, 2];

// Indexed [ecl][version]; index 0 is unused.
const QR_ECC_CODEWORDS_PER_BLOCK = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];
const QR_NUM_ERROR_CORRECTION_BLOCKS = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];

// ---------------------------------------------------------------------------
// QR encoding
// ---------------------------------------------------------------------------

function qrEncode_(text, eclName) {
  const ecl = QR_ECL[eclName || 'H'];
  const data = utf8Bytes_(String(text));

  let version;
  for (version = 1; ; version++) {
    if (version > 40) throw new Error('Text too long for a QR code: ' + data.length + ' bytes');
    const countBits = version <= 9 ? 8 : 16;
    if (4 + countBits + data.length * 8 <= qrNumDataCodewords_(version, ecl) * 8) break;
  }

  // Byte-mode segment: mode indicator, character count, data.
  const bits = [];
  const appendBits = function (value, len) {
    for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  appendBits(0x4, 4);
  appendBits(data.length, version <= 9 ? 8 : 16);
  data.forEach(function (b) { appendBits(b, 8); });

  // Terminator, byte alignment, then alternating pad bytes.
  const capacityBits = qrNumDataCodewords_(version, ecl) * 8;
  appendBits(0, Math.min(4, capacityBits - bits.length));
  appendBits(0, (8 - bits.length % 8) % 8);
  for (let pad = 0xEC; bits.length < capacityBits; pad ^= 0xEC ^ 0x11) appendBits(pad, 8);

  const codewords = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
    codewords.push(byte);
  }
  return qrBuildMatrix_(version, ecl, codewords);
}

function qrBuildMatrix_(version, ecl, dataCodewords) {
  const size = version * 4 + 17;
  const modules = [];
  const isFunction = [];
  for (let y = 0; y < size; y++) {
    modules.push(new Array(size).fill(false));
    isFunction.push(new Array(size).fill(false));
  }
  const setFunction = function (x, y, dark) {
    modules[y][x] = dark;
    isFunction[y][x] = true;
  };
  const getBit = function (x, i) { return ((x >>> i) & 1) !== 0; };

  const drawFormatBits = function (mask) {
    const data = QR_ECL_FORMAT_BITS[ecl] << 3 | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = (data << 10 | rem) ^ 0x5412;
    for (let i = 0; i <= 5; i++) setFunction(8, i, getBit(bits, i));
    setFunction(8, 7, getBit(bits, 6));
    setFunction(8, 8, getBit(bits, 7));
    setFunction(7, 8, getBit(bits, 8));
    for (let i = 9; i < 15; i++) setFunction(14 - i, 8, getBit(bits, i));
    for (let i = 0; i < 8; i++) setFunction(size - 1 - i, 8, getBit(bits, i));
    for (let i = 8; i < 15; i++) setFunction(8, size - 15 + i, getBit(bits, i));
    setFunction(8, size - 8, true); // always-dark module
  };

  // Timing patterns
  for (let i = 0; i < size; i++) {
    setFunction(6, i, i % 2 === 0);
    setFunction(i, 6, i % 2 === 0);
  }
  // Finder patterns (with separators)
  [[3, 3], [size - 4, 3], [3, size - 4]].forEach(function (c) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const x = c[0] + dx, y = c[1] + dy;
        if (x >= 0 && x < size && y >= 0 && y < size) setFunction(x, y, dist !== 2 && dist !== 4);
      }
    }
  });
  // Alignment patterns
  const align = qrAlignmentPositions_(version);
  for (let i = 0; i < align.length; i++) {
    for (let j = 0; j < align.length; j++) {
      const corner = (i === 0 && j === 0) || (i === 0 && j === align.length - 1) || (i === align.length - 1 && j === 0);
      if (corner) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          setFunction(align[i] + dx, align[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
  }
  drawFormatBits(0); // reserve the area; redrawn after choosing the mask
  // Version information (version 7+)
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
    const bits = version << 12 | rem;
    for (let i = 0; i < 18; i++) {
      const dark = getBit(bits, i);
      const a = size - 11 + i % 3, b = Math.floor(i / 3);
      setFunction(a, b, dark);
      setFunction(b, a, dark);
    }
  }

  // Data and error correction codewords, in zigzag order
  const all = qrAddEccAndInterleave_(version, ecl, dataCodewords);
  let bitIndex = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!isFunction[y][x] && bitIndex < all.length * 8) {
          modules[y][x] = getBit(all[bitIndex >>> 3], 7 - (bitIndex & 7));
          bitIndex++;
        }
      }
    }
  }

  // Pick the mask with the lowest penalty (applying a mask twice undoes it).
  let bestMask = 0, bestPenalty = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    qrApplyMask_(modules, isFunction, mask);
    drawFormatBits(mask);
    const penalty = qrPenalty_(modules);
    if (penalty < bestPenalty) { bestPenalty = penalty; bestMask = mask; }
    qrApplyMask_(modules, isFunction, mask);
  }
  qrApplyMask_(modules, isFunction, bestMask);
  drawFormatBits(bestMask);
  return modules;
}

function qrNumRawDataModules_(version) {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

function qrNumDataCodewords_(version, ecl) {
  return Math.floor(qrNumRawDataModules_(version) / 8) -
    QR_ECC_CODEWORDS_PER_BLOCK[ecl][version] * QR_NUM_ERROR_CORRECTION_BLOCKS[ecl][version];
}

function qrAlignmentPositions_(version) {
  if (version === 1) return [];
  const size = version * 4 + 17;
  const numAlign = Math.floor(version / 7) + 2;
  const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (numAlign * 2 - 2)) * 2;
  const result = [6];
  for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
  return result;
}

function qrAddEccAndInterleave_(version, ecl, data) {
  const numBlocks = QR_NUM_ERROR_CORRECTION_BLOCKS[ecl][version];
  const blockEccLen = QR_ECC_CODEWORDS_PER_BLOCK[ecl][version];
  const rawCodewords = Math.floor(qrNumRawDataModules_(version) / 8);
  const numShortBlocks = numBlocks - rawCodewords % numBlocks;
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);
  const divisor = rsDivisor_(blockEccLen);

  const blocks = [];
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = data.slice(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1));
    k += dat.length;
    const ecc = rsRemainder_(dat, divisor);
    if (i < numShortBlocks) dat.push(0);
    blocks.push(dat.concat(ecc));
  }
  const result = [];
  for (let i = 0; i < blocks[0].length; i++) {
    for (let j = 0; j < blocks.length; j++) {
      if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) result.push(blocks[j][i]);
    }
  }
  return result;
}

function rsDivisor_(degree) {
  const result = new Array(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = rsMultiply_(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = rsMultiply_(root, 0x02);
  }
  return result;
}

function rsRemainder_(data, divisor) {
  const result = divisor.map(function () { return 0; });
  data.forEach(function (b) {
    const factor = b ^ result.shift();
    result.push(0);
    divisor.forEach(function (coef, i) { result[i] ^= rsMultiply_(coef, factor); });
  });
  return result;
}

function rsMultiply_(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11D);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

function qrApplyMask_(modules, isFunction, mask) {
  const size = modules.length;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let invert;
      switch (mask) {
        case 0: invert = (x + y) % 2 === 0; break;
        case 1: invert = y % 2 === 0; break;
        case 2: invert = x % 3 === 0; break;
        case 3: invert = (x + y) % 3 === 0; break;
        case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
        case 5: invert = x * y % 2 + x * y % 3 === 0; break;
        case 6: invert = (x * y % 2 + x * y % 3) % 2 === 0; break;
        default: invert = ((x + y) % 2 + x * y % 3) % 2 === 0; break;
      }
      if (invert && !isFunction[y][x]) modules[y][x] = !modules[y][x];
    }
  }
}

function qrPenalty_(modules) {
  const size = modules.length;
  let result = 0;

  const addHistory = function (runLength, history) {
    if (history[0] === 0) runLength += size; // add light border to the initial run
    history.pop();
    history.unshift(runLength);
  };
  const countFinderLike = function (h) {
    const n = h[1];
    const core = n > 0 && h[2] === n && h[3] === n * 3 && h[4] === n && h[5] === n;
    return (core && h[0] >= n * 4 && h[6] >= n ? 1 : 0) + (core && h[6] >= n * 4 && h[0] >= n ? 1 : 0);
  };
  const scanLine = function (get) {
    let runColor = false, runLength = 0, score = 0;
    const history = [0, 0, 0, 0, 0, 0, 0];
    for (let i = 0; i < size; i++) {
      if (get(i) === runColor) {
        runLength++;
        if (runLength === 5) score += 3;
        else if (runLength > 5) score++;
      } else {
        addHistory(runLength, history);
        if (!runColor) score += countFinderLike(history) * 40;
        runColor = get(i);
        runLength = 1;
      }
    }
    if (runColor) { addHistory(runLength, history); runLength = 0; }
    addHistory(runLength + size, history);
    return score + countFinderLike(history) * 40;
  };

  for (let y = 0; y < size; y++) result += scanLine(function (x) { return modules[y][x]; });
  for (let x = 0; x < size; x++) result += scanLine(function (y) { return modules[y][x]; });

  let dark = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (modules[y][x]) dark++;
      if (y < size - 1 && x < size - 1) {
        const c = modules[y][x];
        if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) result += 3;
      }
    }
  }
  const total = size * size;
  result += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
  return result;
}

function utf8Bytes_(str) {
  const out = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.codePointAt(i);
    if (c > 0xFFFF) i++; // surrogate pair
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xC0 | c >> 6, 0x80 | c & 63);
    else if (c < 0x10000) out.push(0xE0 | c >> 12, 0x80 | c >> 6 & 63, 0x80 | c & 63);
    else out.push(0xF0 | c >> 18, 0x80 | c >> 12 & 63, 0x80 | c >> 6 & 63, 0x80 | c & 63);
  }
  return out;
}

// ---------------------------------------------------------------------------
// PNG output (1-bit grayscale, uncompressed deflate blocks)
// ---------------------------------------------------------------------------

/** Renders the QR modules as PNG bytes; each module is `scale` pixels, with `border` light modules around it. */
function qrToPngBytes_(modules, scale, border) {
  const n = modules.length;
  const sizePx = (n + 2 * border) * scale;
  const rowBytes = Math.ceil(sizePx / 8);
  const stride = rowBytes + 1; // leading filter byte (0 = none) per row
  const raw = new Uint8Array(stride * sizePx);

  for (let my = -border; my < n + border; my++) {
    // Build one pixel row for this module row (bit 1 = white, 0 = black)...
    const row = new Uint8Array(rowBytes).fill(0xFF);
    if (my >= 0 && my < n) {
      for (let mx = 0; mx < n; mx++) {
        if (!modules[my][mx]) continue;
        const x0 = (mx + border) * scale;
        for (let x = x0; x < x0 + scale; x++) row[x >> 3] &= ~(0x80 >> (x & 7));
      }
    }
    // ...and repeat it `scale` times.
    const y0 = (my + border) * scale;
    for (let y = y0; y < y0 + scale; y++) raw.set(row, y * stride + 1);
  }

  const ihdr = [].concat(u32be_(sizePx), u32be_(sizePx), [1, 0, 0, 0, 0]); // 1-bit grayscale
  return [].concat(
    [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A],
    pngChunk_('IHDR', ihdr),
    pngChunk_('IDAT', zlibStored_(raw)),
    pngChunk_('IEND', [])
  );
}

function zlibStored_(data) {
  const out = [0x78, 0x01];
  for (let pos = 0; pos < data.length || pos === 0; pos += 65535) {
    const len = Math.min(65535, data.length - pos);
    const final = pos + len >= data.length ? 1 : 0;
    out.push(final, len & 0xFF, len >>> 8, ~len & 0xFF, (~len >>> 8) & 0xFF);
    for (let i = pos; i < pos + len; i++) out.push(data[i]);
    if (len === 0) break;
  }
  let a = 1, b = 0;
  for (let i = 0; i < data.length; i++) {
    a = (a + data[i]) % 65521;
    b = (b + a) % 65521;
  }
  return out.concat(u32be_(((b << 16) | a) >>> 0));
}

function pngChunk_(type, data) {
  const typeBytes = type.split('').map(function (ch) { return ch.charCodeAt(0); });
  const body = typeBytes.concat(data);
  return [].concat(u32be_(data.length), body, u32be_(crc32_(body)));
}

let CRC32_TABLE_ = null;
function crc32_(bytes) {
  if (!CRC32_TABLE_) {
    CRC32_TABLE_ = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      CRC32_TABLE_.push(c >>> 0);
    }
  }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) crc = CRC32_TABLE_[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function u32be_(v) {
  return [(v >>> 24) & 0xFF, (v >>> 16) & 0xFF, (v >>> 8) & 0xFF, v & 0xFF];
}
