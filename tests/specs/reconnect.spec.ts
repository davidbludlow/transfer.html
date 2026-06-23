// Reconnect test: a backgrounded mobile tab gets frozen by the OS and its idle
// relay socket is killed the moment the sender switches away to share the key.
// The sender must survive that — wait until the page is foreground again, re-join
// the same room (its ID is derived from the key, so the key stays valid), and
// finish the transfer once the receiver joins — instead of showing "relay error".
//
// The page needs no test seams: this wraps WebSocket and overrides document
// visibility from the test side only, so it drives the real transfer.html.

import { expect, test } from "@playwright/test";
import { makeSparseFile, receivedBytes, startReceive } from "../helpers/page.js";

const RELAY = "ws://localhost:8080/";
const SIZE = 64 * 1024;

// Record every socket the page opens (so the test can grab and kill the live
// one, and count reconnects) and make document visibility scriptable (so the
// test can fake a backgrounded, frozen tab).
const INIT = `
  const RealWS = window.WebSocket;
  window.__sockets = [];
  function Wrapped(...args){
    const ws = new RealWS(...args);
    window.__lastWS = ws;
    window.__sockets.push(ws);
    return ws;
  }
  Wrapped.prototype = RealWS.prototype;
  for (const k of ['CONNECTING','OPEN','CLOSING','CLOSED']) Wrapped[k] = RealWS[k];
  window.WebSocket = Wrapped;

  let hidden = false;
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => hidden ? 'hidden' : 'visible' });
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  window.__setHidden = (h) => { hidden = h; document.dispatchEvent(new Event('visibilitychange')); };
`;

test("sender survives a backgrounded-tab socket drop and the transfer still completes", async ({ browser }) => {
  const ctx = await browser.newContext({ acceptDownloads: false });
  try {
    const sender = await ctx.newPage();
    await sender.addInitScript(INIT);
    await sender.goto("/transfer.html?relay=" + encodeURIComponent(RELAY));
    await sender.locator("#send-file-mode").click();

    const file = await makeSparseFile("reconnect.bin", SIZE);
    await sender.setInputFiles("#file-input", file);
    await sender.locator("#send-file-button").click();

    // Key is shown; sender is idling, waiting for the receiver.
    await sender.locator("#file-key").filter({ hasNotText: "" }).waitFor({ timeout: 30_000 });
    const key = ((await sender.locator("#file-key").textContent()) || "").trim();
    await expect(sender.locator("#file-status")).toContainText(/waiting for receiver/i);
    const before = await sender.evaluate(() => (window as any).__sockets.length);

    // Phone freezes the backgrounded tab, then the OS kills its idle socket.
    await sender.evaluate(() => (window as any).__setHidden(true));
    await sender.evaluate(() => (window as any).__lastWS.close());

    // While hidden it must NOT reconnect (a frozen tab can't) and must NOT error.
    await sender.waitForTimeout(500);
    expect(await sender.evaluate(() => (window as any).__sockets.length)).toBe(before);
    await expect(sender.locator("#file-status")).not.toHaveClass(/err/);
    await expect(sender.locator("#file-status")).toContainText(/waiting for receiver/i);

    // Back to the foreground: sender reconnects to the same room.
    await sender.evaluate(() => (window as any).__setHidden(false));
    await expect
      .poll(() => sender.evaluate(() => (window as any).__sockets.length), { timeout: 10_000 })
      .toBeGreaterThan(before);

    // Receiver joins with the SAME key; the transfer completes end to end.
    const receiver = await ctx.newPage();
    await receiver.goto("/transfer.html?relay=" + encodeURIComponent(RELAY));
    await receiver.locator("#receive-mode").click();
    await startReceive(receiver, key);

    await expect(receiver.locator("#receive-status")).toHaveClass(/ok/, { timeout: 30_000 });
    await expect(sender.locator("#file-status")).toHaveClass(/ok/, { timeout: 30_000 });
    expect(await receivedBytes(receiver)).toBe(SIZE);
  } finally {
    await ctx.close();
  }
});
