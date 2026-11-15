// Opening password-protected PDFs: the standard security handler, revisions 2 to 6 (RC4 40 and
// 128 bit, AES-128, AES-256). pdf-lib cannot decrypt, so this parses the file with pdf-lib's own
// parser, decrypts every string and stream in place and removes /Encrypt. The result is an
// ordinary pdf-lib document, the same as for an unprotected upload.
//
// Object streams need care: pdf-lib unpacks them while parsing, but they are encrypted as a
// whole, so they can only be unpacked after decryption. While an encrypted file is parsed,
// PDFObjectStreamParser.forStream() therefore only collects them (see collect()).

import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFObjectStreamParser,
  PDFParser,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
  ParseSpeeds,
} from "../vendor/pdf-lib/pdf-lib.esm.min.js";
import { aesCbcDecrypt, md5, rc4, sha256 } from "./crypto.js";
import { hash } from "./encrypt.js";

/** Thrown when the password is missing or wrong; `code` is "password". */
export class PasswordError extends Error {
  constructor(message) {
    super(message);
    this.code = "password";
  }
}

/** Thrown for protection this app cannot remove (e.g. certificates); `code` is "encrypted". */
export class UnsupportedEncryptionError extends Error {
  constructor(message) {
    super(message);
    this.code = "encrypted";
  }
}

// ---------------------------------------------------------------------------------------------
// Parsing with object streams set aside

const collecting = new WeakMap(); // parser → [{ ref, stream }]
let lastHeader = null; // { parser, ref } of the indirect object being parsed

const originalForStream = PDFObjectStreamParser.forStream;
const originalHeader = PDFParser.prototype.parseIndirectObjectHeader;
PDFParser.prototype.parseIndirectObjectHeader = function parseIndirectObjectHeader(...args) {
  const ref = originalHeader.apply(this, args);
  lastHeader = { parser: this, ref };
  return ref;
};
// forStream() comes right after the header of the same object, without an await in between, so
// lastHeader is the object stream's own number even when several files are parsed at once.
PDFObjectStreamParser.forStream = function forStream(stream, ...args) {
  const list = lastHeader && collecting.get(lastHeader.parser);
  if (!list) return originalForStream.call(this, stream, ...args);
  list.push({ ref: lastHeader.ref, stream });
  return { parseIntoContext: async () => {} };
};

async function parseCollecting(bytes) {
  const parser = PDFParser.forBytesWithOptions(bytes, ParseSpeeds.Slow, false, false);
  const objectStreams = [];
  collecting.set(parser, objectStreams);
  try {
    const context = await parser.parseDocument();
    return { context, objectStreams };
  } finally {
    collecting.delete(parser);
  }
}

// ---------------------------------------------------------------------------------------------
// Keys

const PADDING = Uint8Array.from([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
  0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]);

const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};
const equal = (a, b) => a.length === b.length && a.every((byte, i) => byte === b[i]);
const bytesOf = (value) => (value instanceof PDFString || value instanceof PDFHexString ? value.asBytes() : new Uint8Array(0));
const littleEndian = (value, length) => Uint8Array.from({ length }, (_, i) => (value >>> (8 * i)) & 0xff);

/** Revisions 2–4: passwords are PDFDocEncoding, padded to 32 bytes. */
function padded(password) {
  const bytes = Uint8Array.from([...password].slice(0, 32), (char) => (char.charCodeAt(0) < 256 ? char.charCodeAt(0) : 0x3f));
  return concat(bytes, PADDING).subarray(0, 32);
}

/** ISO 32000-2 algorithm 2: the file key from the user password (revisions 2–4). */
function legacyKey(userPassword, enc) {
  let key = md5(concat(userPassword, enc.O.subarray(0, 32), littleEndian(enc.P, 4), enc.id,
    enc.R >= 4 && !enc.encryptMetadata ? Uint8Array.of(0xff, 0xff, 0xff, 0xff) : new Uint8Array(0)));
  if (enc.R >= 3) for (let i = 0; i < 50; i++) key = md5(key.subarray(0, enc.keyLength));
  return key.subarray(0, enc.R === 2 ? 5 : enc.keyLength);
}

/** Algorithms 4 and 5: does `key` belong to the user password? */
function legacyUserMatches(key, enc) {
  if (enc.R === 2) return equal(rc4(key, PADDING), enc.U.subarray(0, 32));
  let value = rc4(key, md5(concat(PADDING, enc.id)));
  for (let i = 1; i <= 19; i++) value = rc4(key.map((byte) => byte ^ i), value);
  return equal(value, enc.U.subarray(0, 16));
}

/** Algorithm 7: the owner password reveals the (padded) user password. */
function legacyOwnerToUser(password, enc) {
  let key = md5(padded(password));
  if (enc.R >= 3) for (let i = 0; i < 50; i++) key = md5(key);
  key = key.subarray(0, enc.R === 2 ? 5 : enc.keyLength);
  if (enc.R === 2) return rc4(key, enc.O.subarray(0, 32));
  let value = enc.O.subarray(0, 32);
  for (let i = 19; i >= 0; i--) value = rc4(key.map((byte) => byte ^ i), value);
  return value;
}

/** Revision 5 hashes with plain SHA-256; revision 6 with algorithm 2.B. */
const modernHash = (R, password, salt, userKey) =>
  R === 5 ? sha256(concat(password, salt, userKey)) : hash(password, salt, userKey);

/** Revisions 5 and 6: the file key for the password, or null if it is neither password. */
function modernKey(password, enc) {
  const secret = new TextEncoder().encode(password.normalize("NFKC")).subarray(0, 127);
  const zero = new Uint8Array(16);
  const U = enc.U.subarray(0, 48);
  const O = enc.O.subarray(0, 48);
  if (equal(modernHash(enc.R, secret, O.subarray(32, 40), U), O.subarray(0, 32))) {
    return aesCbcDecrypt(modernHash(enc.R, secret, O.subarray(40, 48), U), zero, enc.OE, { padding: false });
  }
  if (equal(modernHash(enc.R, secret, U.subarray(32, 40), new Uint8Array(0)), U.subarray(0, 32))) {
    return aesCbcDecrypt(modernHash(enc.R, secret, U.subarray(40, 48), new Uint8Array(0)), zero, enc.UE, { padding: false });
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// The encryption dictionary

function readEncryption(context) {
  const dict = context.lookup(context.trailerInfo.Encrypt);
  if (!(dict instanceof PDFDict)) throw new UnsupportedEncryptionError("The encryption dictionary is missing or damaged.");
  const name = (key, fallback) => dict.lookup(PDFName.of(key))?.asString?.().slice(1) ?? fallback;
  const number = (key, fallback) => {
    const value = dict.lookup(PDFName.of(key));
    return value instanceof PDFNumber ? value.asNumber() : fallback;
  };
  const filter = name("Filter");
  if (filter !== "Standard") {
    throw new UnsupportedEncryptionError(`The file is protected with “${filter ?? "unknown"}” security (for example certificates), which PDF Studio cannot open.`);
  }
  const V = number("V", 0);
  const R = number("R", 2);
  if (![2, 3, 4, 5, 6].includes(R)) throw new UnsupportedEncryptionError(`Unknown encryption revision ${R}.`);

  // Which method encrypts streams and strings: "rc4", "aes128", "aes256" or "none".
  let streamMethod = "rc4";
  let stringMethod = "rc4";
  if (V >= 4) {
    const filters = dict.lookup(PDFName.of("CF"));
    const method = (filterName) => {
      if (filterName === "Identity") return "none";
      const cf = filters instanceof PDFDict ? filters.lookup(PDFName.of(filterName)) : undefined;
      const cfm = cf instanceof PDFDict ? cf.lookup(PDFName.of("CFM"))?.asString?.().slice(1) : undefined;
      if (cfm === "AESV2") return "aes128";
      if (cfm === "AESV3") return "aes256";
      if (cfm === "V2") return "rc4";
      if (cfm === "None" || cfm === undefined) return "none";
      throw new UnsupportedEncryptionError(`Unknown encryption method ${cfm}.`);
    };
    streamMethod = method(name("StmF", "Identity"));
    stringMethod = method(name("StrF", "Identity"));
  }
  const id = context.trailerInfo.ID instanceof PDFArray ? bytesOf(context.lookup(context.trailerInfo.ID.get(0))) : new Uint8Array(0);
  const encryptMetadata = dict.lookup(PDFName.of("EncryptMetadata"))?.asBoolean?.() ?? true;
  return {
    dict, V, R, streamMethod, stringMethod, encryptMetadata, id,
    keyLength: V === 1 ? 5 : Math.max(5, Math.min(16, number("Length", 40) / 8)),
    P: number("P", 0) | 0,
    O: bytesOf(dict.lookup(PDFName.of("O"))),
    U: bytesOf(dict.lookup(PDFName.of("U"))),
    OE: bytesOf(dict.lookup(PDFName.of("OE"))),
    UE: bytesOf(dict.lookup(PDFName.of("UE"))),
  };
}

/** The file key for `password` (user or owner password), or null when it is wrong. */
function fileKey(password, enc) {
  if (enc.R >= 5) return modernKey(password, enc);
  let key = legacyKey(padded(password), enc);
  if (legacyUserMatches(key, enc)) return key;
  key = legacyKey(legacyOwnerToUser(password, enc), enc);
  return legacyUserMatches(key, enc) ? key : null;
}

// ---------------------------------------------------------------------------------------------
// Decrypting

/** A function that decrypts the bytes of object `ref` with `method`. */
function decrypter(key, method, ref) {
  if (method === "none") return (bytes) => bytes;
  if (method === "aes256") return (bytes) => aesCbcDecrypt(key, bytes.subarray(0, 16), bytes.subarray(16));
  // Algorithm 1: the key for one object, from its number and generation.
  const salt = method === "aes128" ? Uint8Array.of(0x73, 0x41, 0x6c, 0x54) : new Uint8Array(0);
  const objectKey = md5(concat(key, littleEndian(ref.objectNumber, 3), littleEndian(ref.generationNumber, 2), salt))
    .subarray(0, Math.min(key.length + 5, 16));
  if (method === "rc4") return (bytes) => rc4(objectKey, bytes);
  return (bytes) => (bytes.length < 16 ? new Uint8Array(0) : aesCbcDecrypt(objectKey, bytes.subarray(0, 16), bytes.subarray(16)));
}

function decryptStrings(container, decrypt) {
  const fix = (value) => {
    if (value instanceof PDFString || value instanceof PDFHexString) return PDFHexString.of(toHex(decrypt(value.asBytes())));
    if (value instanceof PDFDict || value instanceof PDFArray) decryptStrings(value, decrypt);
    return value;
  };
  if (container instanceof PDFDict) {
    for (const [name, value] of [...container.entries()]) container.set(name, fix(value));
  } else {
    for (let i = 0; i < container.size(); i++) container.set(i, fix(container.get(i)));
  }
}

const toHex = (bytes) => {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
};

/**
 * Parses an encrypted PDF and decrypts it with `password` ("" tries the empty user password, which
 * opens files that only restrict permissions). Returns a pdf-lib document without encryption.
 */
export async function loadEncrypted(bytes, password = "") {
  const { context, objectStreams } = await parseCollecting(bytes);
  const enc = readEncryption(context);
  const key = fileKey(password, enc);
  if (!key) throw new PasswordError(password ? "The password is wrong." : "The file needs a password.");

  const encryptRef = context.trailerInfo.Encrypt instanceof PDFRef ? context.trailerInfo.Encrypt : null;
  for (const [ref, object] of [...context.enumerateIndirectObjects()]) {
    if (encryptRef && ref === encryptRef) continue;
    if (object instanceof PDFStream) {
      const dict = object.dict;
      decryptStrings(dict, decrypter(key, enc.stringMethod, ref));
      const type = dict.lookup(PDFName.of("Type"));
      if (type === PDFName.of("XRef")) continue;
      if (type === PDFName.of("Metadata") && !enc.encryptMetadata) continue;
      if (!(object instanceof PDFRawStream)) continue;
      const contents = decrypter(key, enc.streamMethod, ref)(object.contents);
      dict.set(PDFName.of("Length"), PDFNumber.of(contents.length));
      context.assign(ref, PDFRawStream.of(dict, contents));
    } else if (object instanceof PDFDict || object instanceof PDFArray) {
      decryptStrings(object, decrypter(key, enc.stringMethod, ref));
    } else if (object instanceof PDFString || object instanceof PDFHexString) {
      context.assign(ref, PDFHexString.of(toHex(decrypter(key, enc.stringMethod, ref)(object.asBytes()))));
    }
  }

  // Now the object streams can be unpacked. Objects stored directly in the file win over copies
  // in object streams (in incrementally updated files, the direct ones are the newer ones).
  const direct = new Map(context.enumerateIndirectObjects().map(([ref, object]) => [ref, object]));
  for (const { ref, stream } of objectStreams) {
    const contents = decrypter(key, enc.streamMethod, ref)(stream.contents);
    stream.dict.set(PDFName.of("Length"), PDFNumber.of(contents.length));
    await originalForStream.call(PDFObjectStreamParser, PDFRawStream.of(stream.dict, contents), false).parseIntoContext();
  }
  for (const [ref, object] of direct) context.assign(ref, object);

  if (encryptRef) context.delete(encryptRef);
  context.trailerInfo.Encrypt = undefined;
  return new PDFDocument(context, true, false);
}
