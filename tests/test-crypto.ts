// Crypto round-trip tests for transfer.html.
//
// These helpers MUST stay byte-for-byte equivalent to the ones in
// transfer.html. If you change the HKDF info strings, key sizes, IV size,
// frame layout, or anything else cryptographic in the HTML, mirror it here
// and update the assertions accordingly.
//
// Run: deno run test-crypto.ts
//
// (No permission flags needed — Web Crypto and getRandomValues are part of
// Deno's built-in runtime and don't require --allow-* of any kind.)

const TYPE_META = 1;
const TYPE_CHUNK = 2;
const TYPE_END = 3;

function bufToB64u(buf: ArrayBuffer | Uint8Array): string {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64uToBuf(s: string): Uint8Array {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function deriveKeys(secret: string) {
  const enc = new TextEncoder();
  const ikm = enc.encode(secret);
  const baseKey = await crypto.subtle.importKey(
    "raw",
    ikm,
    "HKDF",
    false,
    ["deriveBits"],
  );
  const roomBits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: enc.encode("transfer-room-v1"),
    },
    baseKey,
    128,
  );
  const keyBits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: enc.encode("transfer-key-v1"),
    },
    baseKey,
    256,
  );
  const aesKey = await crypto.subtle.importKey(
    "raw",
    keyBits,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
  return { roomId: bufToB64u(roomBits), aesKey };
}

function frameAdditionalData(type: number, sequenceNumber: number): Uint8Array {
  const bytes = new Uint8Array(9);
  bytes[0] = type;
  new DataView(bytes.buffer).setBigUint64(1, BigInt(sequenceNumber));
  return bytes;
}

async function encryptFrame(
  aesKey: CryptoKey,
  type: number,
  sequenceNumber: number,
  plaintext: Uint8Array,
): Promise<Uint8Array> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: frameAdditionalData(type, sequenceNumber) },
      aesKey,
      plaintext,
    ),
  );
  const out = new Uint8Array(1 + 12 + ct.byteLength);
  out[0] = type;
  out.set(iv, 1);
  out.set(ct, 13);
  return out;
}

async function decryptFrame(
  aesKey: CryptoKey,
  frame: Uint8Array,
  sequenceNumber: number,
): Promise<{ type: number; plaintext: Uint8Array }> {
  if (frame.byteLength < 13) throw new Error("frame too short");
  const type = frame[0];
  const iv = frame.slice(1, 13);
  const ct = frame.slice(13);
  const pt = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, additionalData: frameAdditionalData(type, sequenceNumber) },
      aesKey,
      ct,
    ),
  );
  return { type, plaintext: pt };
}

function eqBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

let pass = 0;
let fail = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`ok    ${name}`);
    pass++;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`FAIL  ${name}: ${msg}`);
    fail++;
  }
}

await test("base64url round-trip preserves random bytes", () => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const back = b64uToBuf(bufToB64u(bytes));
  if (!eqBytes(bytes, back)) throw new Error("mismatch");
});

await test(
  "deriveKeys is deterministic; same secret yields same roomId on both sides",
  async () => {
    const secret = "test-secret-abc123";
    const a = await deriveKeys(secret);
    const b = await deriveKeys(secret);
    if (a.roomId !== b.roomId) throw new Error("roomId mismatch");
    // CryptoKey objects can't be compared directly; verify the keys are
    // operationally identical by encrypting on one side and decrypting on
    // the other.
    const plaintext = new TextEncoder().encode("hello");
    const frame = await encryptFrame(a.aesKey, TYPE_META, 0, plaintext);
    const { plaintext: out } = await decryptFrame(b.aesKey, frame, 0);
    if (!eqBytes(plaintext, out)) throw new Error("cross-decrypt failed");
  },
);

await test("different secrets produce different roomIds", async () => {
  const a = await deriveKeys("secret-1");
  const b = await deriveKeys("secret-2");
  if (a.roomId === b.roomId) throw new Error("roomIds must differ");
});

await test("chunk frame round-trip preserves 64 KiB of random bytes", async () => {
  const { aesKey } = await deriveKeys("rt-test");
  const plaintext = crypto.getRandomValues(new Uint8Array(64 * 1024));
  const frame = await encryptFrame(aesKey, TYPE_CHUNK, 0, plaintext);
  // Layout: 1 type + 12 iv + ciphertext (= plaintext + 16-byte GCM tag)
  const expectedLen = 1 + 12 + plaintext.byteLength + 16;
  if (frame.byteLength !== expectedLen) {
    throw new Error(`frame length ${frame.byteLength}, expected ${expectedLen}`);
  }
  const { type, plaintext: out } = await decryptFrame(aesKey, frame, 0);
  if (type !== TYPE_CHUNK) throw new Error(`type ${type}, expected TYPE_CHUNK`);
  if (!eqBytes(plaintext, out)) throw new Error("plaintext mismatch");
});

await test("metadata frame round-trip handles UTF-8 (filename with emoji)", async () => {
  const { aesKey } = await deriveKeys("meta-test");
  const meta = { type: "file", name: "héllo 🌍 こんにちは.txt", size: 12345 };
  const plaintext = new TextEncoder().encode(JSON.stringify(meta));
  const frame = await encryptFrame(aesKey, TYPE_META, 0, plaintext);
  const { type, plaintext: out } = await decryptFrame(aesKey, frame, 0);
  if (type !== TYPE_META) throw new Error(`type ${type}, expected TYPE_META`);
  const decoded = JSON.parse(new TextDecoder().decode(out));
  if (decoded.name !== meta.name || decoded.size !== meta.size) {
    throw new Error(`metadata mismatch: ${JSON.stringify(decoded)}`);
  }
});

await test("end frame round-trip carries empty plaintext", async () => {
  const { aesKey } = await deriveKeys("end-test");
  const frame = await encryptFrame(aesKey, TYPE_END, 0, new Uint8Array(0));
  const { type, plaintext } = await decryptFrame(aesKey, frame, 0);
  if (type !== TYPE_END) throw new Error(`type ${type}, expected TYPE_END`);
  if (plaintext.byteLength !== 0) throw new Error("end plaintext should be empty");
});

await test("decrypt with the wrong key fails", async () => {
  const a = await deriveKeys("alice");
  const b = await deriveKeys("eve");
  const plaintext = new TextEncoder().encode("secret message");
  const frame = await encryptFrame(a.aesKey, TYPE_CHUNK, 0, plaintext);
  let threw = false;
  try {
    await decryptFrame(b.aesKey, frame, 0);
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("decrypt with wrong key should have thrown");
});

await test("each frame uses a fresh IV (no reuse over 100 frames)", async () => {
  const { aesKey } = await deriveKeys("iv-test");
  const plaintext = new TextEncoder().encode("same plaintext");
  const seen = new Set<string>();
  for (let i = 0; i < 100; i++) {
    const frame = await encryptFrame(aesKey, TYPE_CHUNK, i, plaintext);
    const ivHex = Array.from(frame.slice(1, 13))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    if (seen.has(ivHex)) throw new Error("IV reuse detected");
    seen.add(ivHex);
  }
});

await test("tampered ciphertext fails GCM authentication", async () => {
  const { aesKey } = await deriveKeys("auth-test");
  const plaintext = new TextEncoder().encode("integrity check");
  const frame = await encryptFrame(aesKey, TYPE_CHUNK, 0, plaintext);
  // Flip one bit somewhere inside the ciphertext (well past the IV).
  frame[20] ^= 0x01;
  let threw = false;
  try {
    await decryptFrame(aesKey, frame, 0);
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("tampered frame should fail GCM auth");
});

await test("a frame decrypts only at its own sequence number", async () => {
  const { aesKey } = await deriveKeys("seq-test");
  const plaintext = new TextEncoder().encode("chunk at position 5");
  const frame = await encryptFrame(aesKey, TYPE_CHUNK, 5, plaintext);
  // Same key, same bytes, wrong position: GCM authentication must reject it.
  // This is what makes a reordered, duplicated, or dropped frame fail.
  let threw = false;
  try {
    await decryptFrame(aesKey, frame, 6);
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("frame should not decrypt at the wrong position");
  // ...but still decrypts at its own position.
  const { plaintext: out } = await decryptFrame(aesKey, frame, 5);
  if (!eqBytes(plaintext, out)) throw new Error("round-trip at own seq failed");
});

await test("a frame's type byte is authenticated", async () => {
  const { aesKey } = await deriveKeys("type-test");
  const frame = await encryptFrame(aesKey, TYPE_CHUNK, 0, new Uint8Array(8));
  frame[0] = TYPE_END; // relay relabels a chunk as the end marker
  let threw = false;
  try {
    await decryptFrame(aesKey, frame, 0);
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("relabelled frame should fail GCM auth");
});

await test("swapping two chunks in a stream is detected", async () => {
  const { aesKey } = await deriveKeys("scramble-test");
  // A relay forwards frames in the order it chooses; the receiver decrypts
  // each against its own running counter (0, 1, 2, ...).
  const a = await encryptFrame(aesKey, TYPE_CHUNK, 1, new TextEncoder().encode("AAAA"));
  const b = await encryptFrame(aesKey, TYPE_CHUNK, 2, new TextEncoder().encode("BBBB"));
  // Relay swaps them: receiver tries to read frame b (made for position 2) at
  // position 1, which must fail.
  let threw = false;
  try {
    await decryptFrame(aesKey, b, 1);
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("swapped chunk should fail to decrypt");
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) Deno.exit(1);
