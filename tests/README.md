# Tests

Versioned Playwright tests for `transfer.html`. Lives outside the project root
to keep `node_modules` and other Node-related cruft out of the auditable
surface.

## First-time setup

```sh
cd tests
npm install
npm run install-browsers   # downloads playwright's chromium + firefox builds
```

## Run

```sh
npm test                 # both browsers
npm run test:firefox     # firefox only
npm run test:chromium    # chromium only
```

The Playwright config auto-spawns the relay (deno) and a static http server
(python3) before tests; nothing else needs to be running.

## What's tested

- `specs/transfer.spec.ts` — baseline + experimental coverage of the
  send/receive flow. Each test isolates itself in a fresh browser context.

## Layout

- `playwright.config.ts` — runner config; both browsers as separate projects.
- `helpers/page.ts` — sender/receiver page setup, sparse file generation,
  shared instrumentation (anchor-click suppression, unhandled-rejection
  capture).
- `specs/*.spec.ts` — actual test cases.
- `.scratch/` — sparse test files (gitignored, regenerated each run).

## Note on the `.scratch/` directory

Tests use sparse files (`fs.truncate(N)`) so a 4 GiB "test file" consumes
0 bytes on disk until written. Receiver downloads are intercepted by
no-op'ing `<a download>` clicks, so the harness never writes GiB to disk
even on big-file tests. This is essential for running the suite on
size-constrained machines.
