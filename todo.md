# TODOs

Unprioritized list of ideas and things to revisit. Cross items off when done; expand or split as you actually take them on.

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
