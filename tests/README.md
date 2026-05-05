# Tests

All test code for `transfer.html` and `relay.ts` lives here. Three layers, in increasing weight:

1. Deno scripts that exercise individual pieces (no browser, no Node deps).
2. A Playwright suite that drives the full UI in real browsers.
3. A raw-ws Node load script for measuring relay capacity.

The Playwright machinery (`node_modules/`, `package.json`, etc.) lives inside this `tests/` directory so that the auditable surface at the project root stays clean.

## Layer 1: Deno scripts (no browser, no Node)

Quick feedback for the relay's forwarding logic and the HTML's crypto helpers. Run from the `tests/` directory.

```sh
# Relay integration: spawns the relay, opens two clients in the same room,
# verifies peer-ready notification + message forwarding + cleanup.
cd tests
deno run --allow-net=127.0.0.1 --allow-run=deno test-relay.ts

# Crypto round-trip: HKDF derivation, AES-GCM frame encrypt/decrypt,
# IV freshness, GCM authentication. Replicates the HTML's crypto
# helpers in TypeScript and round-trips them.
deno run test-crypto.ts
```

## Layer 2: Playwright (real browsers)

Drives the actual `transfer.html` in headless Chromium / Firefox. First-time setup:

```sh
cd tests
npm install
npm run install-browsers   # downloads playwright's chromium + firefox builds
```

Run:

```sh
npm test                 # both browsers
npm run test:firefox     # firefox only
npm run test:chromium    # chromium only
```

The Playwright config auto-spawns the relay (deno) and a static http server (python3) before tests; nothing else needs to be running.

What's covered:

- `specs/transfer.spec.ts` — local round-trip + big-file probes (uses the local relay spawned by the config).
- `specs/deployed.spec.ts` — sequential probe against the *deployed* Fly relay (100 MiB → 4 GiB). Useful for verifying real-world deploys.
- `specs/deployed-parallel.spec.ts` — N concurrent transfers against the deployed relay. Configurable via `PARALLEL=10 SIZE_MB=100 npx playwright test specs/deployed-parallel.spec.ts`.

## Layer 3: raw-ws load script (no browsers, no encryption)

Measures the relay's pure forwarding capacity, isolated from any client-side overhead. Useful for capacity sanity-checks and head-to-head relay-implementation comparisons.

```sh
cd tests
PARALLEL=10 SIZE_MB=100 node bench-load.mjs
```

Defaults: `PARALLEL=5`, `SIZE_MB=50`. Override the relay URL with `RELAY=wss://...` if you want to point it at a non-default deployment.

## Manual / agent browser cases

`test-script.md` lists end-to-end scenarios that need a human (or agent) in the loop — refresh-clears-fields, copy-and-clear, etc. These are hard to automate cleanly and serve as the reference for "what behavior should this thing have".

## Layout

- `playwright.config.ts` — Playwright runner config; both browsers as separate projects; auto-spawns relay + static http server.
- `helpers/page.ts` — sender/receiver page setup, sparse file generation, shared instrumentation (anchor-click suppression, unhandled-rejection capture).
- `specs/*.spec.ts` — Playwright cases.
- `bench-load.mjs` — raw-ws Node load script.
- `test-relay.ts`, `test-crypto.ts` — Deno scripts (Layer 1).
- `test-script.md` — manual / agent browser cases.
- `.scratch/` — sparse test files (gitignored, regenerated each run).

## Note on the `.scratch/` directory

Tests use sparse files (`fs.truncate(N)`) so a 4 GiB "test file" consumes 0 bytes on disk until written. Receiver downloads are intercepted by no-op'ing `<a download>` clicks, so the harness never writes GiB to disk even on big-file tests. This is essential for running the suite on size-constrained machines.
