# transfer.html

> Tired of trusting cloud services, your ISP, or random Wi-Fi networks with the files you send? This is one HTML file. You and the recipient open it locally in a browser, share a short code, and the file moves between you encrypted end-to-end. The relay in the middle only ever sees encrypted bytes — even if it's run by an attacker, your data stays safe.

End-to-end encrypted file and text transfer through a dumb relay.

- **Sender** opens `transfer.html` locally, picks a file (or types text), gets a short code.
- **Receiver** opens their own copy of `transfer.html` locally, pastes the code, receives the file (or text).
- A small WebSocket relay forwards encrypted bytes between them. The relay never sees plaintext.

The HTML is a single self-contained file. No frameworks, no CDN, no fonts, no dependencies fetched at runtime. Open it from `file://` and it works.

`transfer.html` is about 600 lines, all in one file. If you know JavaScript, you can audit it end-to-end in roughly an hour. If you don't want to read code, paste it into an LLM — in a few seconds it'll probably tell you it's safe to use.

## Get it

[**View `transfer.html` on GitHub**](https://github.com/davidbludlow/transfer.html/blob/main/transfer.html) — once you're on the file page, click the **Download raw file** icon (in the toolbar above the file content) to save it.

After saving, verify its SHA-256 against the value in [How to verify your copy of the HTML](#how-to-verify-your-copy-of-the-html) below before relying on it. Then open the local copy in any modern browser.

## Why this design

The threat model targets adversaries who can:

- Tamper with traffic on the network path (hostile ISP, hostile public Wi-Fi, hostile state-controlled telecom).
- Compromise a Certificate Authority and forge TLS certificates.
- Compromise the relay server and read everything it sees.
- Record traffic now and decrypt later when quantum computers exist ("harvest now, decrypt later").

What protects against each:

| Threat                              | Protection                                                                 |
|-------------------------------------|----------------------------------------------------------------------------|
| MITM-of-JS (script substitution)    | The HTML is loaded from local disk, not the network. Nothing runs from a server on each use. |
| Hostile ISP / DPI / forged TLS      | All payloads encrypted client-side before TLS. Even broken TLS yields only ciphertext. |
| Compromised relay                   | Relay only sees ciphertext + an opaque room ID. No keys ever transit the relay. |
| Quantum (Shor's algorithm)          | No asymmetric crypto on the wire — no DH, no PAKE, no public-key handshake. There is nothing for Shor to attack. |
| Quantum (Grover's algorithm)        | AES-256-GCM. Grover halves effective key strength to 128 bits, which is unbreakable. |

## Files

- `transfer.html` — the entire client. Open in any modern browser via `file://`.
- `relay.ts` — the WebSocket forwarder. ~130 lines of Deno; uses `npm:ws` for proper backpressure.
- `tests/` — all the test code (Deno scripts, Playwright suite, raw-ws load script, manual cases). See [tests/README.md](tests/README.md).
- `CLAUDE.md` — design notes for future maintainers / AI assistants.

## How to verify your copy of the HTML

The HTML file is the entire trust chain on the client side. Before relying on it, hash it on a trusted system and record the hash somewhere you can re-check later:

```sh
sha256sum transfer.html
```

The current expected hash, for the version of `transfer.html` checked into this commit:

```
8ddfe11d44f185b7b9884be2687ba957b9f9cf544d9fb281ed2829b97fcfb69e  transfer.html
```

If your local copy's hash matches this value, you have the same bytes I (the maintainer) intend to ship. If it doesn't, something has changed — could be a legitimate update from the repo, could be tampering. Investigate before using.

## Running the relay

The relay is a Deno script. On the machine that will host it:

```sh
deno run --allow-net=0.0.0.0:8080 \
         --allow-env=WS_NO_BUFFER_UTIL,WS_NO_UTF_8_VALIDATE,NODE_ENV \
         relay.ts
```

It listens on port 8080 by default. Pass a port as the first argument to change it. The `--allow-net` scope is intentionally narrow; the `--allow-env` scope is just three optional config reads from the `npm:ws` library. No disk access, no subprocess.

For LAN-only use, run it on any machine on your network. The HTML connects via `ws://host:8080/`. For internet use, put it behind a reverse proxy that terminates TLS, and use `wss://`. See `deploy.md` for one specific recipe (Fly.io, scale-to-zero — pennies per month for personal use).

## Running the tests

All tests live under `tests/` — Deno scripts for the relay and crypto path, a Playwright suite that drives real browsers, a raw-ws Node load script, and a manual / agent browser checklist. See [tests/README.md](tests/README.md) for what each one does and how to run it.

## Wire protocol

A frame is a binary WebSocket message:

```
| type:1 | iv:12 | ciphertext+tag:variable |
```

- `type` is `1` (metadata), `2` (chunk), or `3` (end).
- `iv` is a fresh random 12-byte AES-GCM IV per frame.
- `ciphertext+tag` is AES-256-GCM output (ciphertext concatenated with the 16-byte authentication tag).
- The GCM tag also covers the frame's `type` and its sequence number (its 0-based position in the stream). The sequence number is not on the wire — the receiver counts frames itself — so a relay that reorders, duplicates, drops, or relabels frames yields a frame whose position no longer matches and decryption fails. The received bytes are therefore exactly the sent bytes, in order.

The first frame is `metadata`, decrypting to UTF-8 JSON:

```json
{ "type": "file", "name": "...", "size": 1234 }
{ "type": "text", "size": 1234 }
```

Subsequent frames are `chunk` (up to 64 KiB plaintext each) until a final `end` frame.

## Key derivation

Both clients derive a 128-bit room ID and a 256-bit AES key from a single shared secret using HKDF-SHA-256 with separate `info` strings:

```
room_id = HKDF-SHA-256(secret, info="transfer-room-v1", L=128) → base64url
aes_key = HKDF-SHA-256(secret, info="transfer-key-v1",  L=256)
```

The relay sees only `room_id`. The AES key never leaves the browsers.

The shared secret is 256 random bits, base64url-encoded (~43 characters). Generated by the sender, transmitted to the receiver out-of-band (chat message, in person, etc.).

256 bits is chosen to match the AES-256 key size: under Grover's algorithm a quantum attacker would need ~2^128 operations to brute-force the secret, which is the same effective post-quantum strength as the cipher. A shorter secret would be a weaker link than the cipher itself.

## What this does not protect against

- **The endpoints.** If either browser is compromised, the file content leaks. Open the HTML on machines you trust.
- **Traffic analysis.** The relay sees connection metadata (timestamps, byte counts, source IPs) and the opaque room ID. It cannot read content but it can confirm a transfer happened.
- **Shoulder surfing of the secret.** The shared code is shown on screen during sending. Don't share screens during a transfer.
- **A leaked secret.** Anyone who obtains the shared secret can derive the same room ID and key, join the room, and intercept the transfer. Treat the secret like a password for the duration of the transfer.

## Limits

- Both endpoints must be online and connected at the same time. The relay does not store anything.
- One transfer per connection. Refresh the page to start over.
- File size is bounded by browser memory — the receiver assembles the full file before saving. Tested up to 4 GiB through the deployed relay; somewhere above that, V8's typed-array max (~2³¹−1 bytes per allocation) starts to bite even with the chunked-Blob receiver.

## Keywords

end-to-end encrypted file transfer · zero-trust file sharing · self-hosted Send replacement · Firefox Send alternative · single HTML file file transfer · WebCrypto AES-256-GCM transfer · share secrets without trusting the host · post-quantum-resistant file sharing · send a `.env` file securely · send credentials over chat without exposing the chat host · auditable cryptographic file transfer in ~600 lines
