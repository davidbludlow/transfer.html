import { expect, test } from "@playwright/test";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Probe experiment-big-files-2: streaming sender with stop-and-wait
// per-chunk pacing (WS_BUFFER_HIGH=0, drain fully before each read).
// Goal: see if tighter pacing eliminates relay OOM without sacrificing
// the large-file ceiling the streaming sender achieves locally.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRATCH = path.resolve(__dirname, "..", ".scratch");

const DEPLOYED_RELAY = "wss://transfer-html.fly.dev/";
const URL_WITH_RELAY =
  "/transfer.html?relay=" + encodeURIComponent(DEPLOYED_RELAY);

const INSTRUMENTATION = `
  window.__lastError = null;
  window.addEventListener('unhandledrejection', e => {
    window.__lastError = String((e.reason && e.reason.message) || e.reason);
  });
  window.addEventListener('error', e => { window.__lastError = String(e.message); });
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
  try {
    await fh.truncate(bytes);
  } finally {
    await fh.close();
  }
  return fp;
}

test.describe("deployed Fly relay (smarter-relay: Node + ws backpressure)", () => {
  for (const sizeMiB of [100, 500, 1024, 2048, 3072, 4096]) {
    const sizeLabel =
      sizeMiB >= 1024
        ? `${(sizeMiB / 1024).toFixed(2)} GiB`
        : `${sizeMiB} MiB`;
    test(`${sizeLabel} round-trip`, async ({ browser }) => {
      test.setTimeout(60 * 60 * 1000);
      const ctx = await browser.newContext({ acceptDownloads: false });
      try {
        const sender = await ctx.newPage();
        await sender.addInitScript(INSTRUMENTATION);
        await sender.goto(URL_WITH_RELAY);
        await sender.locator("#send-file-mode").click();

        const receiver = await ctx.newPage();
        await receiver.addInitScript(INSTRUMENTATION);
        await receiver.goto(URL_WITH_RELAY);
        await receiver.locator("#receive-mode").click();

        const size = sizeMiB * 1024 * 1024;
        const fp = await makeSparseFile(`dep-main-${sizeMiB}m.bin`, size);

        await sender.setInputFiles("#file-input", fp);
        await sender.locator("#send-file-button").click();
        await sender
          .locator("#file-secret")
          .filter({ hasNotText: "" })
          .waitFor({ timeout: 60 * 1000 });
        const secret =
          ((await sender.locator("#file-secret").textContent()) || "").trim();

        await receiver.locator("#receive-secret-input").fill(secret);
        await receiver.locator("#receive-button").click();

        await expect(receiver.locator("#receive-status")).toHaveClass(/ok|err/, {
          timeout: 55 * 60 * 1000,
        });
        const cls =
          (await receiver.locator("#receive-status").getAttribute("class")) || "";
        const status = await receiver.locator("#receive-status").textContent();
        console.log(`    smarter-relay ${sizeLabel} → ${cls}: ${status}`);
      } finally {
        await ctx.close();
      }
    });
  }
});
