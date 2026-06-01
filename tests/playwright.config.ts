import { defineConfig, devices } from "@playwright/test";

// Test runner config for transfer.html.
//
// Auto-launches the relay (deno) and a static http server (python) so a
// contributor only needs `npx playwright test` after `npm install`. Both
// servers are reused across tests for speed; per-test isolation comes from
// fresh browser contexts.
//
// `workers: 1` because each test holds two pages (sender + receiver) plus
// potentially multi-GiB JS heaps; running tests in parallel risks OOM
// killing the box.

export default defineConfig({
  testDir: "./specs",
  timeout: 5 * 60 * 1000, // big-file transfers can take minutes
  expect: { timeout: 30 * 1000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL: "http://127.0.0.1:8000",
    trace: "retain-on-failure",
    actionTimeout: 30 * 1000,
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
  ],
  webServer: [
    {
      command: "deno run --allow-net=0.0.0.0:8080 --allow-env=WS_NO_BUFFER_UTIL,WS_NO_UTF_8_VALIDATE,NODE_ENV,SIDECAR_URL,SIDECAR_TOKEN ../relay.ts",
      port: 8080,
      reuseExistingServer: !process.env.CI,
      timeout: 30 * 1000,
    },
    {
      command: "python3 -m http.server 8000 --bind 127.0.0.1 --directory ..",
      port: 8000,
      reuseExistingServer: !process.env.CI,
      timeout: 30 * 1000,
    },
  ],
});
