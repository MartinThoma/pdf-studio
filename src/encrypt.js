// Password protection: the PDF 2.0 standard security handler (revision 6, AES-256), because
// pdf-lib cannot encrypt. The cryptography is in crypto.js. Call encryptDocument() on a finished
// pdf-lib document and then save it with `useObjectStreams: false` (object streams would hide
// strings from the encryption).
//
// One password opens the file and also counts as the owner password. Nothing is restricted:
// the point is that the file cannot be opened without the password.

import {
  PDFArray,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
} from "../vendor/pdf-lib/pdf-lib.esm.min.js";
import { aesCbcEncrypt, sha256, sha384, sha512 } from "./crypto.js";
const PERMISSIONS = -4; // every permission

const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};
const random = (length) => globalThis.crypto.getRandomValues(new Uint8Array(length));
const toHex = (bytes) => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
const aesCbcRaw = (key, iv, data) => aesCbcEncrypt(key, iv, data, { padding: false });

/** ISO 32000-2, algorithm 2.B: the password hash of revision 6. */
export function hash(password, salt, userKey) {
  let k = sha256(concat(password, salt, userKey));
  for (let round = 0; ; round++) {
    const k1 = concat(...Array(64).fill(concat(password, k, userKey)));
    const e = aesCbcRaw(k.subarray(0, 16), k.subarray(16, 32), k1);
    let remainder = 0;
    for (let i = 0; i < 16; i++) remainder += e[i];
    k = [sha256, sha384, sha512][remainder % 3](e);
    if (round >= 63 && e[e.length - 1] <= round - 31) return k.subarray(0, 32);
  }
}

function encryptionDictionary(password, fileKey) {
  const zero = new Uint8Array(16);
  const [validation, keySalt] = [random(8), random(8)];
  const userHash = hash(password, validation, new Uint8Array(0));
  const U = concat(userHash, validation, keySalt);
  const UE = aesCbcRaw(hash(password, keySalt, new Uint8Array(0)), zero, fileKey);

  const [ownerValidation, ownerKeySalt] = [random(8), random(8)];
  const O = concat(hash(password, ownerValidation, U), ownerValidation, ownerKeySalt);
  const OE = aesCbcRaw(hash(password, ownerKeySalt, U), zero, fileKey);

  const perms = new Uint8Array(16);
  new DataView(perms.buffer).setInt32(0, PERMISSIONS, true);
  perms.set([0xff, 0xff, 0xff, 0xff, 0x54, 0x61, 0x64, 0x62], 4); // "T" "adb"
  perms.set(random(4), 12);
  const Perms = aesCbcRaw(fileKey, zero, perms); // one block: same as ECB

  return {
    Filter: "Standard", V: 5, R: 6, Length: 256, P: PERMISSIONS,
    CF: { StdCF: { AuthEvent: "DocOpen", CFM: "AESV3", Length: 32 } },
    StmF: "StdCF", StrF: "StdCF",
    O: PDFHexString.of(toHex(O)), U: PDFHexString.of(toHex(U)),
    OE: PDFHexString.of(toHex(OE)), UE: PDFHexString.of(toHex(UE)), Perms: PDFHexString.of(toHex(Perms)),
  };
}

/** Encrypts all strings and streams of `doc` in place and adds the /Encrypt entry. */
export function encryptDocument(doc, password) {
  if (!password) throw new Error("A password is needed.");
  const secret = new TextEncoder().encode(password.normalize("NFKC")).subarray(0, 127);
  const fileKey = random(32);
  const dictionary = encryptionDictionary(secret, fileKey);
  const seal = (bytes) => {
    const iv = random(16);
    return concat(iv, aesCbcEncrypt(fileKey, iv, bytes));
  };
  const sealString = (value) => PDFHexString.of(toHex(seal(value.asBytes())));
  const isString = (value) => value instanceof PDFString || value instanceof PDFHexString;

  function sealContainer(container) {
    if (container instanceof PDFDict) {
      for (const [name, value] of [...container.entries()]) {
        if (isString(value)) container.set(name, sealString(value));
        else if (value instanceof PDFDict || value instanceof PDFArray) sealContainer(value);
      }
    } else {
      for (let i = 0; i < container.size(); i++) {
        const value = container.get(i);
        if (isString(value)) container.set(i, sealString(value));
        else if (value instanceof PDFDict || value instanceof PDFArray) sealContainer(value);
      }
    }
  }

  const { context } = doc;
  for (const [ref, object] of [...context.enumerateIndirectObjects()]) {
    if (object instanceof PDFStream) {
      const contents = seal(object.getContents());
      sealContainer(object.dict);
      object.dict.set(PDFName.of("Length"), PDFNumber.of(contents.length));
      context.assign(ref, PDFRawStream.of(object.dict, contents));
    } else if (object instanceof PDFDict || object instanceof PDFArray) {
      sealContainer(object);
    } else if (isString(object)) {
      context.assign(ref, sealString(object));
    }
  }

  context.trailerInfo.Encrypt = context.register(context.obj(dictionary));
  context.trailerInfo.ID = context.obj([PDFHexString.of(toHex(random(16))), PDFHexString.of(toHex(random(16)))]);
}
