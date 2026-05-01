import { expect, test } from "@playwright/test";
import {
  makeSparseFile,
  newReceiver,
  newSender,
  receivedBytes,
  startReceive,
  startSend,
} from "../helpers/page.js";

test.describe("baseline behaviour (pre-experiment)", () => {
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

  test("file larger than MAX_FILE_BYTES is rejected upfront", async ({
    browser,
  }) => {
    const ctx = await browser.newContext({ acceptDownloads: false });
    try {
      const sender = await newSender(ctx);

      // 1901 MiB — one MiB over the current cap.
      const file = await makeSparseFile("oversize.bin", 1901 * 1024 * 1024);
      await sender.setInputFiles("#file-input", file);
      await sender.locator("#file-go").click();

      await expect(sender.locator("#file-status")).toHaveClass(/err/);
      await expect(sender.locator("#file-status")).toContainText(
        "file is too large",
      );
      // The cap is hit before any room is created, so no secret is ever shown.
      await expect(sender.locator("#file-secret")).toHaveText("");
    } finally {
      await ctx.close();
    }
  });

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
