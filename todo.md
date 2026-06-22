# TODOs

Cross items off when done; expand or split as you actually take them on.

## Top priorities

These probably should be addressed before any real-user rollout.

### Sidecar (or in-relay) cap to prevent abuse and runaway cost

The relay currently has no per-room or per-IP rate limit, no abuse circuit breaker, and no monthly spending cap. A bad actor could pin many long-lived rooms, blast bytes through the relay until it hits Fly's egress bill, or otherwise exhaust resources with no upper bound on operator cost. Need a monthly byte cap that refuses new connections past the limit, plus per-IP / per-room limits to slow individual abusers. Solutions exist; nothing fancy needed.

## Architectural / "explore this" ideas

### Reference: how Wormhole.app does it (research notes, May 2026)

Context for the items below. Wormhole's approach to the same problem space:

- **Two-tier by file size.** Up to 5 GB → encrypt-in-browser, upload to Backblaze B2, store 24 h. Above 5 GB → pure peer-to-peer via WebTorrent; sender keeps the page open until the recipient downloads. So they're both store-and-forward AND P2P-streaming, picking the right one per transfer.
- **Streaming encryption via `webtorrent/wormhole-crypto`** (open source). It implements **RFC 8188 (Encrypted Content-Encoding for HTTP)** — chunks the data into self-contained encrypted records each with a counter-derived nonce. Conceptually identical to our per-frame-IV scheme, just standardized.
- **AES-128-GCM** (we use 256 for the post-quantum Grover margin).
- **Streaming receive** — recipient writes to disk as bytes arrive (almost certainly Service Worker; matches the WebTorrent ecosystem). Recipient can also start downloading before upload finishes.
- **Secret in the URL fragment** so it never hits the server (same as our scheme).

Sources: [wormhole.app/security](https://wormhole.app/security), [github.com/webtorrent/wormhole-crypto](https://github.com/webtorrent/wormhole-crypto), [RFC 8188](https://datatracker.ietf.org/doc/html/rfc8188).

### Streaming receive — write to disk as chunks arrive

The receiver currently holds every decrypted chunk in a `chunks[]` array, builds a single Blob at end-of-transfer, then triggers a download. Peak receiver memory is roughly 2× file size, and on slow/weak devices the post-network save step can take longer than the network transfer itself (observed: 1 GB transferred in 70 s, then 2 min 3 s to assemble + save on an old Android phone). Receiver-side disk-full is also silent until after the wait — the bytes arrive successfully, then the save quietly truncates to 0 bytes.

Approach: register a **Service Worker** that intercepts a synthetic URL, exposes a streaming `Response` body, and pipes chunks from the page straight to the browser's native download manager. Bytes go to disk as they arrive; the page never holds the whole file in memory. Works in every browser with service workers (Chromium, Firefox, Safari, Edge). [StreamSaver.js](https://github.com/jimmywarting/StreamSaver.js) packages this technique; Wormhole almost certainly uses the same idea. (The File System Access API would be cleaner but is Chromium-only; the project rule is no Chrome-only features.)

Cost: requires a second file alongside `transfer.html` (e.g., `transfer-sw.js` for the service worker registration). The "single-file" framing in CLAUDE.md would need an explicit carve-out — worth deliberating before doing. The receiver-memory problem has been the most painful recurring issue across testing, though, so the win is real and big.

### Store-and-forward variant (alternative to the streaming relay)

Instead of bytes streaming live through the relay, the sender encrypts and uploads to object storage; the receiver pulls it back later. The relay shrinks to a small presigned-URL minter. Two shapes the upload can take: a single blob (subject to the AES-GCM 64 GB single-(key,IV) ceiling, so chunked above that), or N sequential URLs / ranges / RFC 8188 records — same idea as our current per-frame model, just over HTTP instead of WebSocket.

Cloudflare R2 is the natural backend because it charges $0 for egress. Rough cost comparison at 1 TB/month: ~$1/mo on R2 vs ~$22/mo on Fly streaming. Sender and receiver no longer need to be online simultaneously. Pairs naturally with streaming receive (above).

Tradeoffs to think about:
- **Breaks the current "no persistence" hard rule in CLAUDE.md.** Ciphertext sits at rest for the TTL window. Still confidential cryptographically (AES-256-GCM is AES-256-GCM whether the bytes are streaming or at rest), but a different threat shape for a compromised storage operator — they can copy ciphertext at leisure rather than needing real-time interception.
- Adds a Cloudflare Worker + R2 vendor surface, comparable operational complexity to the now-archived `cloudflare-turn` experiment.
- Without combining with streaming receive, the receiver-side memory pressure gets **worse** (whole file in one Blob), not better.

Worth treating as a sibling experiment branch (e.g., `experiment-store-and-forward`) rather than a replacement for `main`. Best explored together with streaming receive.

### Redis (or similar in-memory KV) as relay state

Investigate using Redis — or something similar — as part of the relay. Could potentially help with the sidecar metering counter (survives relay restarts, shareable across multiple relay machines if we ever scale that way), room state, or as the storage backend for a store-and-forward variant. Worth comparing both pure in-memory Redis and Redis with persistent-store-cleared-on-restart. Probably applicable to both the streaming-relay architecture (for metering / room state) and a store-and-forward architecture (as the blob store), perhaps differently.

## Code quality / readability

### Rearrange `transfer.html` so the entry points come first

The current source order is constants → `$` helper → base64/crypto/relay/panel helpers → finally the click handlers and `sendData`/`recvData` near the bottom. That fights the project's auditability goal: a reader trying to follow "what happens when I click send" has to scroll past every helper before reaching the actual flow. Reorganize to the newspaper / stepdown structure — constants and the `$` helper at top (with its existing "no, this isn't jQuery" comment), then the send/receive flow and click wiring, then the supporting machinery (crypto, base64, panels, relay socket) below. JavaScript function hoisting makes this safe as a pure code-motion refactor; tests + the crypto round-trip cover any accidental breakage. Add a one-line orientation comment at the top of the script block and a short note in CLAUDE.md so future edits preserve the convention.

## A native (non-browser) version

Long-term thought: write a CLI / native client (likely in Deno) so that the tool isn't subject to browser-extension or browser-bug attack surface. Goals for this version that don't fit the browser:

- **Drop-in replacement, not a rewrite.** Same wire protocol, same shared-secret model. Either client (browser or native) can talk to the other through the same relay.
- **Use a key-encapsulation scheme so a leaked or guessed shared secret matters less.** What we want is something like one of the following — not all the same thing, but worth deciding among:
  - **ML-KEM (Kyber)** — post-quantum KEM. Removes the need for the shared secret to BE the key; instead, derive a per-session key via KEM after a small handshake. The shared "secret" becomes a short identifier, not the cipher key.
  - **PAKE (e.g. SPAKE2, OPAQUE)** — turns a low-entropy password into a strong shared key without ever transmitting the password or anything offline-brute-forceable. Useful if we want users to type short codes by hand.
  - **OPAQUE-style aPAKE with forward secrecy** — same plus rotating keys so old transfers stay safe even if a later session is compromised.

  Decide which property we actually want before picking. If the goal is "shared secret discovery doesn't sink the transfer," PAKE is closest in spirit. If the goal is "post-quantum protection for the data path," ML-KEM is the canonical answer. If both, combine.

  Blocker: at time of writing, Deno's `crypto.subtle` doesn't expose ML-KEM or any PAKE. Wait for it to land, or pull in a vetted Rust library via FFI.

- **Folder transfers.** Browser version is one-file-at-a-time. Native could tar-stream a directory tree. Adds a byte or two to the wire format to distinguish "file" vs "directory entry" frames.

- **Reuse the same `transfer.html` crypto primitives** so a TypeScript version stays byte-for-byte compatible. `tests/test-crypto.ts` already mirrors them; the native client can import from the same helper module.

## Smaller things

- WebRTC P2P branch (`experiment-webrtc-p2p`) and with-fallback branch (`experiment-webrtc-with-fallback`) are validated locally but never tested across two real machines on different networks. Worth doing before any decision to merge either.
- `experiment-big-files-2` is interesting as a comparison point (more HTML complexity, simpler relay) but isn't currently the merge candidate. Decide whether to keep it long-term or archive it.
- The maintainer's `fly.toml` reference in `deploy.md` could drift out of sync with the actual local file. The `.claude/rules/fly-toml-deploy-sync.md` rule reminds AI assistants to update both, but a CI check would be more robust.
