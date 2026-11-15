// SHA-256, SHA-384, SHA-512, AES (CBC), and for older protected files MD5 and RC4, for
// encrypt.js and decrypt.js. Plain JavaScript instead
// of the Web Crypto API, because browsers only offer crypto.subtle on https:// and localhost, and
// PDF Studio also runs from a plain http:// address in the local network (make run).
// crypto.getRandomValues() is available everywhere and is still used for random bytes.
//
// tests/crypto.test.js checks these against Node's crypto module. Only reading old files needs
// MD5 and RC4; new files are always written with AES-256.

// ---------------------------------------------------------------------------------------------
// Constants: fractional parts of square and cube roots of primes, computed instead of typed in.

const PRIMES = [];
for (let n = 2; PRIMES.length < 80; n++) if (PRIMES.every((p) => n % p !== 0)) PRIMES.push(n);

/** floor(n^(1/k)) for a BigInt n, k = 2 or 3. */
function iroot(n, k) {
  const K = BigInt(k);
  let x = BigInt(Math.ceil(Number(n) ** (1 / k))) + (1n << 24n); // above the root
  for (;;) {
    const y = ((K - 1n) * x + n / x ** (K - 1n)) / K;
    if (y >= x) break;
    x = y;
  }
  while (x ** K > n) x--;
  while ((x + 1n) ** K <= n) x++;
  return x;
}

/** The first `bits` bits of the fractional part of the k-th root of p. */
const fraction = (p, k, bits) => iroot(BigInt(p) << BigInt(bits * k), k) & ((1n << BigInt(bits)) - 1n);
const words64 = (values) => {
  const hi = new Uint32Array(values.length);
  const lo = new Uint32Array(values.length);
  values.forEach((value, i) => {
    hi[i] = Number(value >> 32n);
    lo[i] = Number(value & 0xffffffffn);
  });
  return { hi, lo };
};

const K256 = Uint32Array.from(PRIMES.slice(0, 64), (p) => Number(fraction(p, 3, 32)));
const IV256 = Uint32Array.from(PRIMES.slice(0, 8), (p) => Number(fraction(p, 2, 32)));
const K512 = words64(PRIMES.map((p) => fraction(p, 3, 64)));
const IV512 = words64(PRIMES.slice(0, 8).map((p) => fraction(p, 2, 64)));
const IV384 = words64(PRIMES.slice(8, 16).map((p) => fraction(p, 2, 64)));

/** Message padding of the SHA-2 family: 0x80, zeros, the length in bits (big-endian). */
function pad(data, blockSize) {
  const lengthSize = blockSize / 8;
  const out = new Uint8Array(Math.ceil((data.length + 1 + lengthSize) / blockSize) * blockSize);
  out.set(data);
  out[data.length] = 0x80;
  const view = new DataView(out.buffer);
  view.setUint32(out.length - 8, Math.floor(data.length / 0x20000000));
  view.setUint32(out.length - 4, (data.length * 8) >>> 0);
  return view;
}

// ---------------------------------------------------------------------------------------------
// SHA-256

export function sha256(data) {
  const view = pad(data, 64);
  const H = IV256.slice();
  const W = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let offset = 0; offset < view.byteLength; offset += 64) {
    for (let t = 0; t < 16; t++) W[t] = view.getUint32(offset + 4 * t);
    for (let t = 16; t < 64; t++) {
      const s0 = rotr(W[t - 15], 7) ^ rotr(W[t - 15], 18) ^ (W[t - 15] >>> 3);
      const s1 = rotr(W[t - 2], 17) ^ rotr(W[t - 2], 19) ^ (W[t - 2] >>> 10);
      W[t] = W[t - 16] + s0 + W[t - 7] + s1;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let t = 0; t < 64; t++) {
      const t1 = h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K256[t] + W[t];
      const t2 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c));
      h = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    [a, b, c, d, e, f, g, h].forEach((value, i) => (H[i] += value));
  }
  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  H.forEach((value, i) => outView.setUint32(4 * i, value));
  return out;
}

// ---------------------------------------------------------------------------------------------
// SHA-512 and SHA-384, with each 64-bit word as a pair of 32-bit halves (hi, lo).

// Rotate right by n (n ≠ 0, 32), shift right by n < 32: the high and the low half of the result.
const rotrHi = (h, l, n) => (n < 32 ? (h >>> n) | (l << (32 - n)) : (l >>> (n - 32)) | (h << (64 - n)));
const rotrLo = (h, l, n) => (n < 32 ? (l >>> n) | (h << (32 - n)) : (h >>> (n - 32)) | (l << (64 - n)));
const shrLo = (h, l, n) => (l >>> n) | (h << (32 - n));
const CARRY = 0x100000000;

function sha512core(data, iv, size) {
  const view = pad(data, 128);
  const Hh = iv.hi.slice();
  const Hl = iv.lo.slice();
  const Wh = new Uint32Array(80);
  const Wl = new Uint32Array(80);
  for (let offset = 0; offset < view.byteLength; offset += 128) {
    for (let t = 0; t < 16; t++) {
      Wh[t] = view.getUint32(offset + 8 * t);
      Wl[t] = view.getUint32(offset + 8 * t + 4);
    }
    for (let t = 16; t < 80; t++) {
      const [h15, l15, h2, l2] = [Wh[t - 15], Wl[t - 15], Wh[t - 2], Wl[t - 2]];
      const s0h = rotrHi(h15, l15, 1) ^ rotrHi(h15, l15, 8) ^ (h15 >>> 7);
      const s0l = rotrLo(h15, l15, 1) ^ rotrLo(h15, l15, 8) ^ shrLo(h15, l15, 7);
      const s1h = rotrHi(h2, l2, 19) ^ rotrHi(h2, l2, 61) ^ (h2 >>> 6);
      const s1l = rotrLo(h2, l2, 19) ^ rotrLo(h2, l2, 61) ^ shrLo(h2, l2, 6);
      const lo = (s1l >>> 0) + Wl[t - 7] + (s0l >>> 0) + Wl[t - 16];
      Wl[t] = lo;
      Wh[t] = s1h + Wh[t - 7] + s0h + Wh[t - 16] + Math.floor(lo / CARRY);
    }
    let [ah, bh, ch, dh, eh, fh, gh, hh] = Hh;
    let [al, bl, cl, dl, el, fl, gl, hl] = Hl;
    for (let t = 0; t < 80; t++) {
      const S1h = rotrHi(eh, el, 14) ^ rotrHi(eh, el, 18) ^ rotrHi(eh, el, 41);
      const S1l = rotrLo(eh, el, 14) ^ rotrLo(eh, el, 18) ^ rotrLo(eh, el, 41);
      const chh = (eh & fh) ^ (~eh & gh);
      const chl = (el & fl) ^ (~el & gl);
      const t1l = hl + (S1l >>> 0) + (chl >>> 0) + K512.lo[t] + Wl[t];
      const t1h = hh + S1h + chh + K512.hi[t] + Wh[t] + Math.floor(t1l / CARRY);
      const S0h = rotrHi(ah, al, 28) ^ rotrHi(ah, al, 34) ^ rotrHi(ah, al, 39);
      const S0l = rotrLo(ah, al, 28) ^ rotrLo(ah, al, 34) ^ rotrLo(ah, al, 39);
      const majh = (ah & bh) ^ (ah & ch) ^ (bh & ch);
      const majl = (al & bl) ^ (al & cl) ^ (bl & cl);
      const t2l = (S0l >>> 0) + (majl >>> 0);
      const t2h = S0h + majh + Math.floor(t2l / CARRY);
      hh = gh; hl = gl;
      gh = fh; gl = fl;
      fh = eh; fl = el;
      const el2 = dl + (t1l >>> 0);
      eh = (dh + t1h + Math.floor(el2 / CARRY)) >>> 0; el = el2 >>> 0;
      dh = ch; dl = cl;
      ch = bh; cl = bl;
      bh = ah; bl = al;
      const al2 = (t1l >>> 0) + (t2l >>> 0);
      ah = (t1h + t2h + Math.floor(al2 / CARRY)) >>> 0; al = al2 >>> 0;
    }
    [[ah, al], [bh, bl], [ch, cl], [dh, dl], [eh, el], [fh, fl], [gh, gl], [hh, hl]].forEach(([h, l], i) => {
      const lo = Hl[i] + l;
      Hl[i] = lo;
      Hh[i] = Hh[i] + h + Math.floor(lo / CARRY);
    });
  }
  const out = new Uint8Array(64);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) {
    outView.setUint32(8 * i, Hh[i]);
    outView.setUint32(8 * i + 4, Hl[i]);
  }
  return out.slice(0, size);
}

export const sha512 = (data) => sha512core(data, IV512, 64);
export const sha384 = (data) => sha512core(data, IV384, 48);

// ---------------------------------------------------------------------------------------------
// AES (encryption only), table-based.

const SBOX = new Uint8Array(256);
{
  const rotl8 = (x, s) => ((x << s) | (x >>> (8 - s))) & 0xff;
  let p = 1;
  let q = 1;
  do {
    p = (p ^ (p << 1) ^ (p & 0x80 ? 0x1b : 0)) & 0xff; // p · 3
    q ^= q << 1; // q / 3
    q ^= q << 2;
    q ^= q << 4;
    q &= 0xff;
    if (q & 0x80) q ^= 0x09;
    SBOX[p] = q ^ rotl8(q, 1) ^ rotl8(q, 2) ^ rotl8(q, 3) ^ rotl8(q, 4) ^ 0x63;
  } while (p !== 1);
  SBOX[0] = 0x63;
}
const xtime = (x) => ((x << 1) ^ (x & 0x80 ? 0x1b : 0)) & 0xff;
const T0 = new Uint32Array(256);
const T1 = new Uint32Array(256);
const T2 = new Uint32Array(256);
const T3 = new Uint32Array(256);
for (let x = 0; x < 256; x++) {
  const s = SBOX[x];
  const word = ((xtime(s) << 24) | (s << 16) | (s << 8) | (xtime(s) ^ s)) >>> 0;
  T0[x] = word;
  T1[x] = (word >>> 8) | (word << 24);
  T2[x] = (word >>> 16) | (word << 16);
  T3[x] = (word >>> 24) | (word << 8);
}

/** The round keys for a 16- or 32-byte key. */
function expandKey(key) {
  if (key.length !== 16 && key.length !== 32) throw new Error("AES key must be 16 or 32 bytes.");
  const nk = key.length / 4;
  const rounds = nk + 6;
  const w = new Uint32Array(4 * (rounds + 1));
  const view = new DataView(key.buffer, key.byteOffset, key.byteLength);
  for (let i = 0; i < nk; i++) w[i] = view.getUint32(4 * i);
  const sub = (x) => (SBOX[x >>> 24] << 24) | (SBOX[(x >>> 16) & 0xff] << 16) | (SBOX[(x >>> 8) & 0xff] << 8) | SBOX[x & 0xff];
  let rcon = 1;
  for (let i = nk; i < w.length; i++) {
    let temp = w[i - 1];
    if (i % nk === 0) {
      temp = sub((temp << 8) | (temp >>> 24)) ^ (rcon << 24);
      rcon = xtime(rcon);
    } else if (nk > 6 && i % nk === 4) {
      temp = sub(temp);
    }
    w[i] = w[i - nk] ^ temp;
  }
  return { w, rounds };
}

/** Encrypts the block in `s` (four words) in place. */
function encryptBlock({ w, rounds }, s) {
  let s0 = s[0] ^ w[0];
  let s1 = s[1] ^ w[1];
  let s2 = s[2] ^ w[2];
  let s3 = s[3] ^ w[3];
  let k = 4;
  for (let round = 1; round < rounds; round++, k += 4) {
    const t0 = T0[s0 >>> 24] ^ T1[(s1 >>> 16) & 0xff] ^ T2[(s2 >>> 8) & 0xff] ^ T3[s3 & 0xff] ^ w[k];
    const t1 = T0[s1 >>> 24] ^ T1[(s2 >>> 16) & 0xff] ^ T2[(s3 >>> 8) & 0xff] ^ T3[s0 & 0xff] ^ w[k + 1];
    const t2 = T0[s2 >>> 24] ^ T1[(s3 >>> 16) & 0xff] ^ T2[(s0 >>> 8) & 0xff] ^ T3[s1 & 0xff] ^ w[k + 2];
    const t3 = T0[s3 >>> 24] ^ T1[(s0 >>> 16) & 0xff] ^ T2[(s1 >>> 8) & 0xff] ^ T3[s2 & 0xff] ^ w[k + 3];
    s0 = t0;
    s1 = t1;
    s2 = t2;
    s3 = t3;
  }
  const last = (a, b, c, d) => (SBOX[a >>> 24] << 24) | (SBOX[(b >>> 16) & 0xff] << 16) | (SBOX[(c >>> 8) & 0xff] << 8) | SBOX[d & 0xff];
  s[0] = last(s0, s1, s2, s3) ^ w[k];
  s[1] = last(s1, s2, s3, s0) ^ w[k + 1];
  s[2] = last(s2, s3, s0, s1) ^ w[k + 2];
  s[3] = last(s3, s0, s1, s2) ^ w[k + 3];
}

/**
 * AES-CBC encryption with a 16- or 32-byte key. With `padding` (PKCS #7, the default) any data
 * length works; without, the length must be a multiple of 16.
 */
export function aesCbcEncrypt(key, iv, data, { padding = true } = {}) {
  let input = data;
  if (padding) {
    const extra = 16 - (data.length % 16);
    input = new Uint8Array(data.length + extra);
    input.set(data);
    input.fill(extra, data.length);
  } else if (data.length % 16 !== 0) {
    throw new Error("Without padding, the data must be a multiple of 16 bytes.");
  }
  const schedule = expandKey(key);
  const out = new Uint8Array(input.length);
  const inView = new DataView(input.buffer, input.byteOffset, input.byteLength);
  const outView = new DataView(out.buffer);
  const ivView = new DataView(iv.buffer, iv.byteOffset, 16);
  const s = new Uint32Array([ivView.getUint32(0), ivView.getUint32(4), ivView.getUint32(8), ivView.getUint32(12)]);
  for (let offset = 0; offset < input.length; offset += 16) {
    for (let i = 0; i < 4; i++) s[i] ^= inView.getUint32(offset + 4 * i);
    encryptBlock(schedule, s);
    for (let i = 0; i < 4; i++) outView.setUint32(offset + 4 * i, s[i]);
  }
  return out;
}

/** Decrypts the block in `s` (four words) in place, with the schedule from decryptionKey(). */
function decryptBlock({ w, rounds }, s) {
  let s0 = s[0] ^ w[0];
  let s1 = s[1] ^ w[1];
  let s2 = s[2] ^ w[2];
  let s3 = s[3] ^ w[3];
  let k = 4;
  for (let round = 1; round < rounds; round++, k += 4) {
    const t0 = D0[s0 >>> 24] ^ D1[(s3 >>> 16) & 0xff] ^ D2[(s2 >>> 8) & 0xff] ^ D3[s1 & 0xff] ^ w[k];
    const t1 = D0[s1 >>> 24] ^ D1[(s0 >>> 16) & 0xff] ^ D2[(s3 >>> 8) & 0xff] ^ D3[s2 & 0xff] ^ w[k + 1];
    const t2 = D0[s2 >>> 24] ^ D1[(s1 >>> 16) & 0xff] ^ D2[(s0 >>> 8) & 0xff] ^ D3[s3 & 0xff] ^ w[k + 2];
    const t3 = D0[s3 >>> 24] ^ D1[(s2 >>> 16) & 0xff] ^ D2[(s1 >>> 8) & 0xff] ^ D3[s0 & 0xff] ^ w[k + 3];
    s0 = t0;
    s1 = t1;
    s2 = t2;
    s3 = t3;
  }
  const last = (a, b, c, d) => (INV_SBOX[a >>> 24] << 24) | (INV_SBOX[(b >>> 16) & 0xff] << 16) | (INV_SBOX[(c >>> 8) & 0xff] << 8) | INV_SBOX[d & 0xff];
  s[0] = last(s0, s3, s2, s1) ^ w[k];
  s[1] = last(s1, s0, s3, s2) ^ w[k + 1];
  s[2] = last(s2, s1, s0, s3) ^ w[k + 2];
  s[3] = last(s3, s2, s1, s0) ^ w[k + 3];
}

const INV_SBOX = new Uint8Array(256);
for (let x = 0; x < 256; x++) INV_SBOX[SBOX[x]] = x;
const gmul = (a, b) => {
  let product = 0;
  for (; b; b >>= 1, a = xtime(a)) if (b & 1) product ^= a;
  return product;
};
const D0 = new Uint32Array(256);
const D1 = new Uint32Array(256);
const D2 = new Uint32Array(256);
const D3 = new Uint32Array(256);
for (let x = 0; x < 256; x++) {
  const s = INV_SBOX[x];
  const word = ((gmul(s, 14) << 24) | (gmul(s, 9) << 16) | (gmul(s, 13) << 8) | gmul(s, 11)) >>> 0;
  D0[x] = word;
  D1[x] = (word >>> 8) | (word << 24);
  D2[x] = (word >>> 16) | (word << 16);
  D3[x] = (word >>> 24) | (word << 8);
}

/** Round keys for the equivalent inverse cipher: reversed, with InvMixColumns on the middle ones. */
function decryptionKey(key) {
  const { w, rounds } = expandKey(key);
  const d = new Uint32Array(w.length);
  for (let round = 0; round <= rounds; round++) {
    for (let i = 0; i < 4; i++) {
      const word = w[4 * (rounds - round) + i];
      d[4 * round + i] = round === 0 || round === rounds
        ? word
        : D0[SBOX[word >>> 24]] ^ D1[SBOX[(word >>> 16) & 0xff]] ^ D2[SBOX[(word >>> 8) & 0xff]] ^ D3[SBOX[word & 0xff]];
    }
  }
  return { w: d, rounds };
}

/**
 * AES-CBC decryption with a 16- or 32-byte key. With `padding` (PKCS #7, the default) the padding
 * is removed; padding that is not valid is left in place rather than failing, as PDF readers do.
 */
export function aesCbcDecrypt(key, iv, data, { padding = true } = {}) {
  const length = data.length - (data.length % 16); // ignore a broken partial last block
  const schedule = decryptionKey(key);
  const out = new Uint8Array(length);
  const inView = new DataView(data.buffer, data.byteOffset, length);
  const outView = new DataView(out.buffer);
  const ivView = new DataView(iv.buffer, iv.byteOffset, 16);
  const prev = new Uint32Array([ivView.getUint32(0), ivView.getUint32(4), ivView.getUint32(8), ivView.getUint32(12)]);
  const s = new Uint32Array(4);
  for (let offset = 0; offset < length; offset += 16) {
    for (let i = 0; i < 4; i++) s[i] = inView.getUint32(offset + 4 * i);
    const cipher = s.slice();
    decryptBlock(schedule, s);
    for (let i = 0; i < 4; i++) outView.setUint32(offset + 4 * i, s[i] ^ prev[i]);
    prev.set(cipher);
  }
  if (!padding || length === 0) return out;
  const extra = out[length - 1];
  if (extra < 1 || extra > 16 || out.subarray(length - extra).some((byte) => byte !== extra)) return out;
  return out.subarray(0, length - extra);
}

// ---------------------------------------------------------------------------------------------
// MD5 and RC4, only for reading files protected with the older PDF security handlers (R2–R4).

const MD5_SHIFT = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
const MD5_K = Uint32Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000));

export function md5(data) {
  const out = new Uint8Array(Math.ceil((data.length + 9) / 64) * 64);
  out.set(data);
  out[data.length] = 0x80;
  const view = new DataView(out.buffer);
  view.setUint32(out.length - 8, (data.length * 8) >>> 0, true);
  view.setUint32(out.length - 4, Math.floor(data.length / 0x20000000), true);
  const H = new Uint32Array([0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476]);
  const M = new Uint32Array(16);
  for (let offset = 0; offset < out.length; offset += 64) {
    for (let j = 0; j < 16; j++) M[j] = view.getUint32(offset + 4 * j, true);
    let [a, b, c, d] = H;
    for (let i = 0; i < 64; i++) {
      let f;
      let g;
      if (i < 16) [f, g] = [(b & c) | (~b & d), i];
      else if (i < 32) [f, g] = [(d & b) | (~d & c), (5 * i + 1) % 16];
      else if (i < 48) [f, g] = [b ^ c ^ d, (3 * i + 5) % 16];
      else [f, g] = [c ^ (b | ~d), (7 * i) % 16];
      f = (f + a + MD5_K[i] + M[g]) >>> 0;
      const shift = MD5_SHIFT[(i >> 4) * 4 + (i % 4)];
      a = d;
      d = c;
      c = b;
      b = (b + ((f << shift) | (f >>> (32 - shift)))) >>> 0;
    }
    H[0] += a;
    H[1] += b;
    H[2] += c;
    H[3] += d;
  }
  const digest = new Uint8Array(16);
  const digestView = new DataView(digest.buffer);
  H.forEach((value, i) => digestView.setUint32(4 * i, value, true));
  return digest;
}

/** RC4 (encryption and decryption are the same). */
export function rc4(key, data) {
  const S = Uint8Array.from({ length: 256 }, (_, i) => i);
  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + S[i] + key[i % key.length]) & 0xff;
    [S[i], S[j]] = [S[j], S[i]];
  }
  const out = new Uint8Array(data.length);
  for (let n = 0, i = 0, j = 0; n < data.length; n++) {
    i = (i + 1) & 0xff;
    j = (j + S[i]) & 0xff;
    [S[i], S[j]] = [S[j], S[i]];
    out[n] = data[n] ^ S[(S[i] + S[j]) & 0xff];
  }
  return out;
}
