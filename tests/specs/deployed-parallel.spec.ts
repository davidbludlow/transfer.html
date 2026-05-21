import { expect, test } from "@playwright/test";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Parallel-transfer load probe against the deployed relay. Each iteration
// opens N pairs of pages and runs N concurrent transfers of SIZE_MB each.
// Configure via env: PARALLEL=10 SIZE_MB=100 npx playwright test ...

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRATCH = path.resolve(__dirname, "..", ".scratch");

const DEPLOYED_RELAY = "wss://davidbludlow-transfer-html-relay.fly.dev/";
const URL_WITH_RELAY =
  "/transfer.html?relay=" + encodeURIComponent(DEPLOYED_RELAY);

const PARALLEL = Number(process.env.PARALLEL || 5);
const SIZE_MB = Number(process.env.SIZE_MB || 100);

const INSTRUMENTATION = `
  const origAnchorClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function() {
    if (this.download !== undefined && this.download !== '') return;
    return origAnchorClick.apply(this, arguments);
  };
`;

async function makeSparseFile(name: string, bytes: number): Promise<string> {
  await fs.mkdir(SCRATCH, { recursive: true });
  const fp = path.join(SCRATCH, name);
  const fh = await fs.open(fp, "w");
  try { await fh.truncate(bytes); } finally { await fh.close(); }
  return fp;
}

async function oneTransfer(browser: any, idx: number): Promise<{ ok: boolean; ms: number; status: string | null }> {
  const ctx = await browser.newContext({ acceptDownloads: false });
  const t0 = Date.now();
  try {
    const sender = await ctx.newPage();
    await sender.addInitScript(INSTRUMENTATION);
    await sender.goto(URL_WITH_RELAY);
    const receiver = await ctx.newPage();
    await receiver.addInitScript(INSTRUMENTATION);
    await receiver.goto(URL_WITH_RELAY);
    await receiver.locator("#receive-mode").click();

    const fp = await makeSparseFile(`par-${idx}-${SIZE_MB}m.bin`, SIZE_MB * 1024 * 1024);
    await sender.setInputFiles("#file-input", fp);
    await sender.locator("#send-file-button").click();
    await sender.locator("#file-secret").filter({ hasNotText: "" }).waitFor({ timeout: 60 * 1000 });
    const secret = ((await sender.locator("#file-secret").textContent()) || "").trim();

    await receiver.locator("#receive-secret-input").fill(secret);
    await receiver.locator("#receive-button").click();
    await expect(receiver.locator("#receive-status")).toHaveClass(/ok|err/, { timeout: 30 * 60 * 1000 });
    const cls = (await receiver.locator("#receive-status").getAttribute("class")) || "";
    const status = await receiver.locator("#receive-status").textContent();
    return { ok: cls.includes("ok"), ms: Date.now() - t0, status };
  } catch (err: any) {
    return { ok: false, ms: Date.now() - t0, status: `exception: ${err.message}` };
  } finally {
    await ctx.close();
  }
}

test.describe("parallel load probe (deployed relay)", () => {
  test(`${PARALLEL}× ${SIZE_MB} MiB concurrent`, async ({ browser }) => {
    test.setTimeout(60 * 60 * 1000);
    const t0 = Date.now();
    const results = await Promise.all(
      Array.from({ length: PARALLEL }, (_, i) => oneTransfer(browser, i)),
    );
    const total = Date.now() - t0;
    const ok = results.filter((r) => r.ok).length;
    const fail = results.length - ok;
    const totalMb = PARALLEL * SIZE_MB;
    const aggMbps = (totalMb * 8) / (total / 1000);
    console.log(`\n=== ${PARALLEL}× ${SIZE_MB} MiB parallel ===`);
    console.log(`  ok=${ok}/${results.length} fail=${fail}`);
    console.log(`  wall: ${(total / 1000).toFixed(1)}s | aggregate: ${aggMbps.toFixed(0)} Mbps (${(aggMbps / 8).toFixed(1)} MB/s)`);
    results.forEach((r, i) => {
      console.log(`  [${i}] ${r.ok ? "✓" : "✗"} ${(r.ms / 1000).toFixed(1)}s — ${r.status}`);
    });
  });
});
