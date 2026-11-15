import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { test } from "node:test";
import { aesCbcDecrypt, aesCbcEncrypt, md5, rc4, sha256, sha384, sha512 } from "../src/crypto.js";

// Around the block and length-field boundaries of SHA-256 (64) and SHA-512 (128), and longer.
const LENGTHS = [0, 1, 3, 15, 16, 17, 55, 56, 63, 64, 65, 111, 112, 119, 120, 127, 128, 129, 255, 256, 1000, 15296, 70000];

test("MD5, SHA-256, SHA-384 and SHA-512 match Node's crypto", () => {
  for (const length of LENGTHS) {
    const data = randomBytes(length);
    for (const [name, fn] of [["md5", md5], ["sha256", sha256], ["sha384", sha384], ["sha512", sha512]]) {
      const expected = createHash(name).update(data).digest("hex");
      assert.equal(Buffer.from(fn(new Uint8Array(data))).toString("hex"), expected, `${name} of ${length} bytes`);
    }
  }
  assert.equal(Buffer.from(sha256(new TextEncoder().encode("abc"))).toString("hex"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});

test("AES-128-CBC and AES-256-CBC match Node's crypto, with and without padding", () => {
  for (const bits of [128, 256]) {
    for (const length of LENGTHS) {
      const key = randomBytes(bits / 8);
      const iv = randomBytes(16);
      const data = randomBytes(length);
      const cipher = createCipheriv(`aes-${bits}-cbc`, key, iv);
      const expected = Buffer.concat([cipher.update(data), cipher.final()]).toString("hex");
      const actual = aesCbcEncrypt(new Uint8Array(key), new Uint8Array(iv), new Uint8Array(data));
      assert.equal(Buffer.from(actual).toString("hex"), expected, `AES-${bits} of ${length} bytes`);
      if (length % 16 === 0) {
        const raw = createCipheriv(`aes-${bits}-cbc`, key, iv).setAutoPadding(false);
        const rawExpected = Buffer.concat([raw.update(data), raw.final()]).toString("hex");
        const rawActual = aesCbcEncrypt(new Uint8Array(key), new Uint8Array(iv), new Uint8Array(data), { padding: false });
        assert.equal(Buffer.from(rawActual).toString("hex"), rawExpected, `AES-${bits} of ${length} bytes without padding`);
      }
    }
  }
});

test("AES works on views into a larger buffer", () => {
  const buffer = new Uint8Array(randomBytes(80));
  const [key, iv, data] = [buffer.subarray(1, 33), buffer.subarray(33, 49), buffer.subarray(49, 80)];
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  const expected = Buffer.concat([cipher.update(data), cipher.final()]).toString("hex");
  assert.equal(Buffer.from(aesCbcEncrypt(key, iv, data)).toString("hex"), expected);
});

test("AES-CBC decryption reverses Node's encryption, with and without padding", () => {
  for (const bits of [128, 256]) {
    for (const length of LENGTHS) {
      const key = randomBytes(bits / 8);
      const iv = randomBytes(16);
      const data = randomBytes(length);
      const cipher = createCipheriv(`aes-${bits}-cbc`, key, iv);
      const encrypted = new Uint8Array(Buffer.concat([cipher.update(data), cipher.final()]));
      const decrypted = aesCbcDecrypt(new Uint8Array(key), new Uint8Array(iv), encrypted);
      assert.equal(Buffer.from(decrypted).toString("hex"), data.toString("hex"), `AES-${bits} of ${length} bytes`);
      const raw = aesCbcDecrypt(new Uint8Array(key), new Uint8Array(iv), encrypted, { padding: false });
      const nodeRaw = createDecipheriv(`aes-${bits}-cbc`, key, iv).setAutoPadding(false);
      assert.equal(Buffer.from(raw).toString("hex"), Buffer.concat([nodeRaw.update(encrypted), nodeRaw.final()]).toString("hex"));
    }
  }
});

test("RC4 matches Node's crypto (when its OpenSSL still offers RC4) and is its own inverse", (t) => {
  const key = new Uint8Array(randomBytes(16));
  const data = new Uint8Array(randomBytes(5000));
  assert.deepEqual(rc4(key, rc4(key, data)), data);
  // Known answer: RC4 with key "Key" and plaintext "Plaintext".
  const known = rc4(new TextEncoder().encode("Key"), new TextEncoder().encode("Plaintext"));
  assert.equal(Buffer.from(known).toString("hex"), "bbf316e8d940af0ad3");
  try {
    const cipher = createCipheriv("rc4", key, null);
    assert.equal(Buffer.from(rc4(key, data)).toString("hex"), Buffer.concat([cipher.update(data), cipher.final()]).toString("hex"));
  } catch (error) {
    if (!/unsupported|not supported|Unknown cipher/i.test(error.message)) throw error;
    t.diagnostic("OpenSSL without RC4: only the known answer was checked");
  }
});
