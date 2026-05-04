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
      const secret = await startSend(sender, file);
      await startReceive(receiver, secret);

      await expect(receiver.locator("#recv-status")).toHaveClass(/ok/);
      await expect(receiver.locator("#recv-file-info")).toContainText(
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
      const secret = await startSend(sender, file);
      await startReceive(receiver, secret);

      await expect(receiver.locator("#recv-status")).toHaveClass(/ok/, {
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
      await sender.locator("#m-send-text").click();
      await sender.locator("#text-input").fill(text);
      await sender.locator("#text-go").click();
      await sender
        .locator("#text-secret")
        .filter({ hasNotText: "" })
        .waitFor();
      const secret = (
        (await sender.locator("#text-secret").textContent()) || ""
      ).trim();

      await receiver.locator("#recv-secret").fill(secret);
      await receiver.locator("#recv-go").click();

      await expect(receiver.locator("#recv-status")).toHaveClass(/ok/);
      await expect(receiver.locator("#recv-text")).toHaveText(text);
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
        const secret = await startSend(sender, file);
        await startReceive(receiver, secret);

        await expect(receiver.locator("#recv-status")).toHaveClass(/ok|err/, {
          timeout: 55 * 60 * 1000,
        });
        const status = await receiver.locator("#recv-status").textContent();
        const cls = await receiver
          .locator("#recv-status")
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
    // The receiver's `if (total !== metadata.size) throw` guard should fire if
    // the sender ever transmits fewer bytes than its own metadata claims.
    // We simulate this by patching encryptFrame on the sender to drop chunks.
    const ctx = await browser.newContext({ acceptDownloads: false });
    try {
      const sender = await newSender(ctx);
      const receiver = await newReceiver(ctx);

      // After we click send, swallow every TYPE_CHUNK frame so the receiver
      // sees only TYPE_META + TYPE_END and assembles 0 bytes.
      await sender.evaluate(() => {
        const ws_proto = WebSocket.prototype;
        const origSend = ws_proto.send;
        ws_proto.send = function (data: any) {
          if (data instanceof Uint8Array && data[0] === 2 /* TYPE_CHUNK */) {
            return; // drop
          }
          return origSend.call(this, data);
        };
      });

      const file = await makeSparseFile("short-payload.bin", 64 * 1024);
      const secret = await startSend(sender, file);
      await startReceive(receiver, secret);

      await expect(receiver.locator("#recv-status")).toHaveClass(/err/);
      await expect(receiver.locator("#recv-status")).toContainText(
        "incomplete transfer",
      );
    } finally {
      await ctx.close();
    }
  });
});
