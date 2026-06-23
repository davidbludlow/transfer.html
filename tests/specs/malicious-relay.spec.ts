// End-to-end integrity tests: drive real browsers (sender + receiver) through a
// deliberately-malicious relay (helpers/malicious-relay.ts) and confirm the
// receiver never accepts tampered data as a successful transfer.
//
// Each frame is AES-GCM-authenticated against its type and its position in the
// stream, so a relay that reorders, duplicates, drops, relabels, or truncates
// frames produces a frame whose authenticated context no longer matches —
// decryption fails and the receiver reports an error instead of a file.
//
// A "none" control proves the harness itself forwards faithfully (so the
// failures below are the integrity check firing, not a broken test relay).

import { expect, test } from "@playwright/test";
import { type ChildProcess, spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  makeSparseFile,
  startReceive,
  startSend,
} from "../helpers/page.js";
import type { BrowserContext, Page } from "@playwright/test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RELAY_SCRIPT = path.resolve(__dirname, "..", "helpers", "malicious-relay.ts");

// 256 KiB = 4 chunks, so the attacks (which target the 2nd chunk) have room.
const SIZE = 256 * 1024;

function startRelay(attack: string, port: number): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      "deno",
      [
        "run",
        `--allow-net=127.0.0.1:${port}`,
        RELAY_SCRIPT,
        `--port=${port}`,
        `--attack=${attack}`,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let ready = false;
    proc.stdout.on("data", (d) => {
      if (String(d).includes(`on :${port}`)) {
        ready = true;
        resolve(proc);
      }
    });
    let stderr = "";
    proc.stderr.on("data", (d) => (stderr += String(d)));
    proc.on("exit", (code) => {
      if (!ready) reject(new Error(`relay exited (${code}) before listening:\n${stderr}`));
    });
    setTimeout(() => {
      if (!ready) reject(new Error("relay did not start within 10s"));
    }, 10_000);
  });
}

async function stopRelay(proc: ChildProcess) {
  await new Promise<void>((resolve) => {
    proc.on("exit", () => resolve());
    proc.kill("SIGKILL");
  });
}

async function pageAt(ctx: BrowserContext, port: number, modeButton: string): Promise<Page> {
  const page = await ctx.newPage();
  // Record every value #receive-status ever shows, into window.__statusLog.
  // This lets a test prove the receiver actually got going (e.g. decrypted the
  // metadata, so the status read "receiving …") before it errored — rather
  // than erroring for an unrelated setup reason like the page not loading.
  await page.addInitScript(() => {
    (window as any).__statusLog = [];
    addEventListener("DOMContentLoaded", () => {
      const el = document.getElementById("receive-status");
      if (!el) return;
      const record = () => { if (el.textContent) (window as any).__statusLog.push(el.textContent); };
      record();
      new MutationObserver(record).observe(el, {
        childList: true, subtree: true, characterData: true,
      });
    });
  });
  await page.goto("/transfer.html?relay=" + encodeURIComponent(`ws://127.0.0.1:${port}/`));
  await page.locator(modeButton).click();
  return page;
}

// Each attack gets its own port so a lingering socket can't cross tests.
const ATTACKS: Array<{ name: string; port: number }> = [
  { name: "reorder", port: 8101 },
  { name: "duplicate", port: 8102 },
  { name: "drop", port: 8103 },
  { name: "relabel", port: 8104 },
  { name: "truncate", port: 8105 },
];

test.describe("malicious relay cannot corrupt a transfer", () => {
  test("control: an honest relay (no attack) still succeeds", async ({ browser }) => {
    const relay = await startRelay("none", 8100);
    const ctx = await browser.newContext({ acceptDownloads: false });
    try {
      const sender = await pageAt(ctx, 8100, "#send-file-mode");
      const receiver = await pageAt(ctx, 8100, "#receive-mode");
      const file = await makeSparseFile("mal-control.bin", SIZE);
      const key = await startSend(sender, file);
      await startReceive(receiver, key);

      await expect(receiver.locator("#receive-status")).toHaveClass(/ok/, { timeout: 30_000 });
    } finally {
      await ctx.close();
      await stopRelay(relay);
    }
  });

  for (const { name, port } of ATTACKS) {
    test(`${name}: receiver rejects the transfer`, async ({ browser }) => {
      const relay = await startRelay(name, port);
      const ctx = await browser.newContext({ acceptDownloads: false });
      try {
        const sender = await pageAt(ctx, port, "#send-file-mode");
        const receiver = await pageAt(ctx, port, "#receive-mode");
        const file = await makeSparseFile(`mal-${name}.bin`, SIZE);
        const key = await startSend(sender, file);
        await startReceive(receiver, key);

        // The transfer must end in an error, and no file may be presented.
        await expect(receiver.locator("#receive-status")).toHaveClass(/err/, { timeout: 30_000 });
        await expect(receiver.locator("#received-file-wrap")).toBeHidden();

        // Guard against a false pass: the error must come from the integrity
        // check firing mid-transfer, not from some unrelated setup failure
        // (page didn't load, couldn't reach the relay, no sender, etc.). Every
        // attack tampers with the 2nd chunk, so the receiver always decrypts
        // the metadata frame first and shows "receiving …". If that state never
        // appeared, the transfer never really started and the test proved
        // nothing.
        const reachedReceiving = await receiver.evaluate(() =>
          ((window as any).__statusLog || []).some((s: string) => /receiving/i.test(s))
        );
        expect(
          reachedReceiving,
          "receiver should have started receiving (metadata decrypted) before the integrity check fired",
        ).toBe(true);
      } finally {
        await ctx.close();
        await stopRelay(relay);
      }
    });
  }
});
