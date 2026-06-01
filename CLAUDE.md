# Notes for future maintainers

## What this project is

A minimal end-to-end encrypted file/text transfer tool. The client is a single static HTML file; the server is a dumb WebSocket relay. The whole codebase is intentionally small enough that one person can audit it in an afternoon.

## Goals, in order of priority

1. **Resistance to MITM-of-JavaScript.** The client must be loadable from local disk, so an attacker on the network cannot substitute the page contents. This is why it is a single self-contained `transfer.html` file with no external scripts, no CDN, no remote fonts. Do not introduce any runtime fetches of code or assets.
2. **Resistance to a malicious relay or compromised network.** The relay must never see plaintext or any key material. All payloads are encrypted client-side before they enter the relay's view. The relay sees only an opaque room ID and ciphertext.
3. **Resistance to a malicious internet service provider.** This is mostly subsumed by (1) and (2): even if TLS is broken or forged, the attacker gets the same ciphertext the relay would.
4. **Shor-immunity on the wire.** Nothing that breaks under Shor's algorithm protects data in transit. The strict requirement is Shor-immunity, not "no asymmetric crypto" — post-quantum asymmetric primitives (e.g., ML-KEM / Kyber, ML-DSA / Dilithium) are also Shor-immune and would be acceptable in principle. The current design satisfies Shor-immunity trivially: a 256-bit pre-shared secret plus AES-256-GCM, with no key exchange of any kind. AES gives 128-bit post-quantum symmetric strength under Grover's algorithm, which is unbreakable. The current design avoids asymmetric primitives by choice (see "Cryptographic preferences" below) for audit-surface reasons, not Shor reasons.
5. **Auditability.** The whole thing should remain small. Originally aspired to HTML under 400 lines and relay under 100 lines; current reality is ~600 HTML / ~130 relay, exceeded for justified reasons (browser-cap workarounds for >2 GiB transfers; proper relay backpressure). Resist the urge to add frameworks, build steps, or further dependency trees beyond the one current `npm:ws` import. Within `transfer.html`, prefer HTML and CSS over JavaScript when either can do the job, because declarative markup and stylesheets are dramatically easier to scan for malicious behavior than imperative code, and almost every interesting attack lives in JS.

## Hard rules

- **No external runtime dependencies in the HTML.** Vanilla JS, Web Crypto API, plain CSS. If you find yourself wanting to import a library, justify it in writing. (The relay imports one library — `npm:ws` — for proper TCP backpressure that Deno's standard WebSocket can't provide. Justification is documented in the `relay.ts` header. Don't add more without similar justification.)
- **No telemetry.** No analytics, no error reporting, no health checks that phone home, no metrics endpoints that include user data.
- **No persistence in the relay.** The relay holds no state across restarts. Rooms are in-memory only and time out. If you add storage to the relay, you've broken the threat model. (The optional metering sidecar in `worker/sidecar.js` does hold a single per-month byte counter in Workers KV — that's metering state, not user data, and it lives in a different process. A compromised sidecar would only leak "this many bytes flowed in month X.")
- **Single-machine deployment.** The relay holds rooms in process-local memory; two machines do not share state. If a hosting platform's default is multi-machine HA, force single-machine (e.g. `fly deploy --ha=false`). Do not "fix" this with shared storage — that violates the no-persistence rule above. If you ever need true HA, the right move is sticky routing by room ID, not shared state.
- **No `--allow-all` for the relay.** The relay needs `--allow-net` plus a narrowly-scoped `--allow-env` for `ws`'s three optional config reads (`WS_NO_BUFFER_UTIL`, `WS_NO_UTF_8_VALIDATE`, `NODE_ENV`) and the two optional sidecar config reads (`SIDECAR_URL`, `SIDECAR_TOKEN`). No disk, no subprocess, no broader env access. If the sidecar is enabled, `--allow-net` also needs the sidecar's host added (e.g. `your-sidecar.workers.dev:443`).
- **Shor-immune on the wire.** No primitive that Shor's algorithm breaks may protect any data in transit. This bans RSA, classical Diffie-Hellman, ECDH (X25519, P-256, P-521, etc.), classical PAKEs (SPAKE2, OPAQUE), and ECC-based signatures. There is no exception.
- **Never weaken the cipher.** AES-256-GCM is the minimum. Don't downgrade to AES-128 even if "the secret has 128 bits of entropy" — Grover halves it.
- **Never store secrets.** No password managers, no autofill, no cached form data. The HTML actively suppresses browser persistence on input fields. Preserve those attributes (`autocomplete=off`, `autocorrect=off`, `autocapitalize=off`, `spellcheck=false`, `data-form-type=other`, no `name=` attribute, no enclosing `<form>`).

## Cryptographic preferences

These are softer than the hard rules above — exceptions are possible but require deliberate written argument before merging.

- **No key exchange at all.** The pre-shared-secret + AEAD design is the simplest way to satisfy Shor-immunity, and it minimizes the cryptographic audit surface to HKDF + AES-GCM. If you must add a key exchange — for example to gain forward secrecy — it must be post-quantum (ML-KEM or a hybrid like X25519+ML-KEM where the X25519 half is treated as defense-in-depth, not load-bearing). Any key-exchange addition is a non-trivial expansion of trust surface; argue for it in writing before merging.

## Wire protocol invariants

- Frame format: `[type:1 byte] [iv:12 bytes] [ciphertext+tag]`. Each frame is independently AES-256-GCM-encrypted with a fresh random IV.
- First frame is metadata (JSON, UTF-8). Subsequent frames are chunks. Final frame is `end` (empty plaintext).
- IVs are random per frame, not counter-based. Don't change to a counter scheme without thinking carefully about IV reuse — Web Crypto generates fresh IVs every frame and that is safe.
- Chunk size is 64 KiB. Reasonable for memory and progress reporting; do not bloat without reason.

## Cryptographic invariants

- HKDF-SHA-256 derives both the 128-bit room ID and the 256-bit AES key from a single shared secret. Distinct `info` strings ("transfer-room-v1", "transfer-key-v1") provide domain separation.
- The shared secret is 256 random bits, base64url-encoded. This matches the AES-256 key size so Grover gives the same 128-bit post-quantum strength as the cipher; a shorter secret would be the weaker link. If you change `SECRET_BYTES`, do not go below 32 — and do not change the encoding.
- The room ID is shown to the relay. The AES key is not. If you change derivations, preserve this property.

## Adding features

If you must add functionality, prefer additions that do not expand the trust boundary:

- More UI polish: fine, as long as no new dependencies.
- Resumable transfers: requires state somewhere; carefully consider where.
- Folder transfers: doable via tarring in the browser, but adds significant code. Justify before adding.
- Multiple recipients: requires changes to relay matching logic. Think through the implications for room ID collisions and replay.
- Authentication of the relay itself: redundant — the relay sees only ciphertext, so authenticating it adds nothing.

Avoid:

- Login/accounts of any kind.
- Persistent identifiers.
- Anything that requires the relay to do more than forward bytes.

## Testing

Three layers, in increasing weight:

- **`test-relay.ts`** — Deno script. Exercises the relay's WebSocket forwarding (peer-ready, message forward, cleanup) without browsers.
- **`test-crypto.ts`** — Deno script. Round-trips the HTML's crypto helpers (HKDF, AES-GCM frame encrypt/decrypt) without browsers.
- **`tests/`** — Playwright suite. Real browsers (Chromium, Firefox), real `transfer.html`, drives the full UI. Includes:
  - `tests/specs/transfer.spec.ts` — local round-trip, big-file probes
  - `tests/specs/deployed.spec.ts` — sequential probe against the deployed relay
  - `tests/specs/deployed-parallel.spec.ts` — N concurrent transfers
  - `tests/bench-load.mjs` — raw-ws Node load test (no browsers, no encryption — purely tests relay forwarding capacity)

The HTML's crypto path is best validated by manual round-trip testing in a real browser, or by the Playwright spec.

Don't accept a PR that loosens permission scopes or adds dependencies just to make tests easier.

## Out of scope

- Mobile apps.
- A native CLI client (use existing tools like `croc` or `magic-wormhole` instead).
- Hosting service / SaaS deployment. The relay is meant to be self-hosted by whoever uses it.

## Writing docs and comments

Document the current state, not the transition that produced it. Phrases like "X doesn't Y anymore", "used to do Z, now does W", or "instead of A, the code uses B" only make sense to a reader who remembers the prior version. A fresh reader doesn't, and the transition residue makes the doc harder to follow because it sounds like it's explaining a *change* when it should just be explaining what the thing *is*. Drop the framing and describe what the system does.

Same for code comments: "now uses Y" → "uses Y"; "replaced the old foo with bar" → "uses bar".

Commit messages and PR descriptions are the place for "what changed" — that's their entire job. Don't smuggle that content into source files or operator docs.

## When in doubt

The default answer is "no, keep it small." Every line added is a line that has to be re-audited by every user before they trust the build.
