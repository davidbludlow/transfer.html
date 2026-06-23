import { expect, test } from "@playwright/test";
import {
  makeSparseFile,
  newReceiver,
  newSender,
  receivedBytes,
  startReceive,
  startSend,
} from "../helpers/page.js";

test.describe("baseline behaviour", () => {
  test("round-trip 100 KiB", async ({ browser }) => {
    const ctx = await browser.newContext({ acceptDownloads: false });
    try {
      const sender = await newSender(ctx);
      const receiver = await newReceiver(ctx);

      const size = 100 * 1024;
      const file = await makeSparseFile("rt-100k.bin", size);
      const key = await startSend(sender, file);
      await startReceive(receiver, key);

      await expect(receiver.locator("#receive-status")).toHaveClass(/ok/);
      await expect(receiver.locator("#received-file-info")).toContainText(
        `(${size} bytes)`,
      );
      expect(await receivedBytes(receiver)).toBe(size);
    } finally {
      await ctx.close();
    }
  });

  test("round-trip 100 MiB (exercises streaming sender at scale)", async ({
    browser,
  }) => {
    const ctx = await browser.newContext({ acceptDownloads: false });
    try {
      const sender = await newSender(ctx);
      const receiver = await newReceiver(ctx);

      const size = 100 * 1024 * 1024;
      const file = await makeSparseFile("rt-100m.bin", size);
      const key = await startSend(sender, file);
      await startReceive(receiver, key);

      await expect(receiver.locator("#receive-status")).toHaveClass(/ok/, {
        timeout: 120 * 1000,
      });
      expect(await receivedBytes(receiver)).toBe(size);
    } finally {
      await ctx.close();
    }
  });

  test("text round-trip preserves multi-byte UTF-8", async ({ browser }) => {
    const ctx = await browser.newContext({ acceptDownloads: false });
    try {
      const sender = await newSender(ctx);
      const receiver = await newReceiver(ctx);

      const text = "héllo 🌍 こんにちは — line two\nline three";

      // Switch sender to text mode and submit.
      await sender.locator("#send-text-mode").click();
      await sender.locator("#text-input").fill(text);
      await sender.locator("#send-text-button").click();
      await sender
        .locator("#text-key")
        .filter({ hasNotText: "" })
        .waitFor();
      const key = (
        (await sender.locator("#text-key").textContent()) || ""
      ).trim();

      await receiver.locator("#receive-key-input").fill(key);
      await receiver.locator("#receive-button").click();

      await expect(receiver.locator("#receive-status")).toHaveClass(/ok/);
      await expect(receiver.locator("#received-text")).toHaveText(text);
    } finally {
      await ctx.close();
    }
  });

  // Bracket the per-browser ceiling. Each test records the outcome rather
  // than asserting, since the point of the experiment is to discover the
  // empirical limit. Failure mode should always be "clean" — either an
  // explicit error status or a thrown exception, never silent corruption.
  for (
    const sizeGiB of [1, 1.5, 1.75, 1.9, 2, 2.25, 2.5, 2.75, 3, 4, 6, 8, 10, 12, 15, 20]
  ) {
    test(`${sizeGiB} GiB round-trip (probe)`, async ({ browser }) => {
      test.setTimeout(60 * 60 * 1000);
      const ctx = await browser.newContext({ acceptDownloads: false });
      try {
        const sender = await newSender(ctx);
        const receiver = await newReceiver(ctx);

        const size = Math.floor(sizeGiB * 1024 ** 3);
        const file = await makeSparseFile(`rt-${sizeGiB}g.bin`, size);
        const key = await startSend(sender, file);
        await startReceive(receiver, key);

        await expect(receiver.locator("#receive-status")).toHaveClass(/ok|err/, {
          timeout: 55 * 60 * 1000,
        });
        const status = await receiver.locator("#receive-status").textContent();
        const cls = await receiver
          .locator("#receive-status")
          .getAttribute("class");
        const project = test.info().project.name;
        console.log(`    [${project}] ${sizeGiB} GiB → ${cls}: ${status}`);

        // Whichever way it landed, must NOT be silent corruption: if status
        // is "ok", the reported byte count must match the source size.
        if (cls?.includes("ok")) {
          expect(await receivedBytes(receiver)).toBe(size);
        }
      } finally {
        await ctx.close();
      }
    });
  }

  test("receiver rejects payload shorter than metadata.size", async ({
    browser,
  }) => {
    // The receiver's `if (received !== metadata.size) throw` guard catches a
    // sender whose metadata advertises more bytes than it actually streams.
    // (A relay that drops, reorders, or duplicates frames is caught earlier, by
    // the per-frame sequence authentication — see malicious-relay.spec.ts. This
    // size check is the remaining defense against a sender whose own metadata
    // and payload disagree.) We simulate such a sender by inflating the size it
    // writes into the metadata frame while leaving the streamed bytes unchanged,
    // so every frame still decrypts and only the end-of-transfer check fires.
    const ctx = await browser.newContext({ acceptDownloads: false });
    try {
      const sender = await newSender(ctx);
      const receiver = await newReceiver(ctx);

      await sender.evaluate(() => {
        const origStringify = JSON.stringify;
        (JSON as any).stringify = function (value: any, ...rest: any[]) {
          if (
            value && (value.type === "file" || value.type === "text") &&
            typeof value.size === "number"
          ) {
            value = { ...value, size: value.size + 1_000_000 };
          }
          return origStringify.call(JSON, value, ...rest);
        };
      });

      const file = await makeSparseFile("short-payload.bin", 64 * 1024);
      const key = await startSend(sender, file);
      await startReceive(receiver, key);

      await expect(receiver.locator("#receive-status")).toHaveClass(/err/);
      await expect(receiver.locator("#receive-status")).toContainText(
        "incomplete transfer",
      );
    } finally {
      await ctx.close();
    }
  });
});
