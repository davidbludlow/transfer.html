import type { BrowserContext, Page } from "@playwright/test";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SCRATCH = path.resolve(__dirname, "..", ".scratch");

export const TRANSFER_URL =
  "/transfer.html?relay=" + encodeURIComponent("ws://localhost:8080/");

// Make a sparse file of the given size. Sparse means 0 actual disk usage
// (the OS fills with zeros on read). Suitable for stress-testing the
// transfer path without filling /home.
export async function makeSparseFile(
  name: string,
  bytes: number,
): Promise<string> {
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

// Inject diagnostics + suppress the receiver's anchor-click download (so
// big-file tests don't write GiB to disk for every run).
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

export async function newSender(ctx: BrowserContext): Promise<Page> {
  const page = await ctx.newPage();
  await page.addInitScript(INSTRUMENTATION);
  await page.goto(TRANSFER_URL);
  await page.locator("#m-send-file").click();
  return page;
}

export async function newReceiver(ctx: BrowserContext): Promise<Page> {
  const page = await ctx.newPage();
  await page.addInitScript(INSTRUMENTATION);
  await page.goto(TRANSFER_URL);
  await page.locator("#m-receive").click();
  return page;
}

// Send a file from the sender page; returns the secret displayed.
export async function startSend(
  sender: Page,
  filePath: string,
  timeoutMs = 30 * 1000,
): Promise<string> {
  await sender.setInputFiles("#file-input", filePath);
  await sender.locator("#file-go").click();
  await sender
    .locator("#file-secret")
    .filter({ hasNotText: "" })
    .waitFor({ timeout: timeoutMs });
  return ((await sender.locator("#file-secret").textContent()) || "").trim();
}

export async function startReceive(receiver: Page, secret: string) {
  await receiver.locator("#recv-secret").fill(secret);
  await receiver.locator("#recv-go").click();
}

// Read the byte count from "received: filename (N bytes)" in #recv-file-info.
export async function receivedBytes(receiver: Page): Promise<number | null> {
  const text = (await receiver.locator("#recv-file-info").textContent()) || "";
  const m = text.match(/\((\d+) bytes\)/);
  return m ? parseInt(m[1], 10) : null;
}
