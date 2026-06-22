#!/usr/bin/env node
// Load test the deployed relay using raw ws connections.
//
// Each "pair" opens two WebSockets to the same room ID, waits for the
// relay's peer-ready signal, then the sender pumps SIZE_MB of zero-bytes
// through to the receiver in 64 KiB chunks. No encryption — we're testing
// the relay's forwarding capacity, not the crypto path.
//
// Run: PARALLEL=10 SIZE_MB=100 node tests/bench-load.mjs
//      (defaults: PARALLEL=5, SIZE_MB=50)
//
// Optional: RELAY=wss://... to override the deployed relay URL.

import { WebSocket } from "ws";
import { randomBytes } from "node:crypto";

// Some failed WS upgrades surface as uncaught socket errors that escape
// ws's own error event. Log and continue — individual transfers will see
// their own close/error events.
process.on("uncaughtException", (err) => {
  console.error(`[uncaught] ${err.code || ""}: ${err.message}`);
});
process.on("unhandledRejection", (err) => {
  console.error(`[unhandled] ${err?.message || err}`);
});

const PARALLEL = Number(process.env.PARALLEL || 5);
const SIZE_MB  = Number(process.env.SIZE_MB || 50);
const RELAY    = process.env.RELAY || "wss://transfer-html.fly.dev/";
const CHUNK    = 64 * 1024;
const SBUF_HIGH = 4 * 1024 * 1024;

function roomId() {
  // Match the relay's regex /^[A-Za-z0-9_-]{1,128}$/ — base64url is fine.
  return randomBytes(16).toString("base64url");
}

// Create a WS and attach all handlers SYNCHRONOUSLY before any messages
// can arrive. Returns a { ws, peerReady, openOrError } bundle. The
// peerReady promise resolves when the relay sends `{"ev":"peer"}`.
// `onBinary` is called for every binary message AFTER peer-ready.
function makeClient(url, onBinary) {
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";

  let resolvePR, rejectPR;
  const peerReady = new Promise((res, rej) => { resolvePR = res; rejectPR = rej; });
  let peerReadySeen = false;

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      onBinary?.(data);
      return;
    }
    if (peerReadySeen) return;
    try {
      const obj = JSON.parse(data.toString());
      if (obj.ev === "peer") {
        peerReadySeen = true;
        resolvePR();
      }
    } catch { /* ignore */ }
  });

  const openOrError = new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", (err) => { rejectPR(err); reject(err); });
    ws.once("close", () => {
      if (!peerReadySeen) rejectPR(new Error("ws closed before peer-ready"));
    });
  });

  return { ws, peerReady, openOrError };
}

async function waitForDrain(ws, threshold) {
  while (ws.bufferedAmount > threshold && ws.readyState === WebSocket.OPEN) {
    await new Promise((r) => setTimeout(r, 25));
  }
}

const PER_PAIR_TIMEOUT_MS = 120 * 1000;

async function transferPair(idx, totalBytes) {
  const url = RELAY.replace(/\/$/, "") + "/?room=" + roomId();
  const t0 = Date.now();

  let received = 0;
  let resolveRecv, rejectRecv;
  const recvDone = new Promise((res, rej) => { resolveRecv = res; rejectRecv = rej; });

  const sender   = makeClient(url, () => {}); // sender ignores anything inbound
  const receiver = makeClient(url, (data) => {
    received += data.byteLength;
    if (received >= totalBytes) resolveRecv();
  });

  receiver.ws.once("close", () => {
    if (received < totalBytes) rejectRecv(new Error(`recv closed at ${received}/${totalBytes}`));
  });

  // Hard per-pair deadline so a single stuck transfer doesn't hang the
  // whole Promise.all (and leak its WS connections at the relay).
  const deadline = new Promise((_, rej) =>
    setTimeout(() => rej(new Error(`pair timeout @ ${PER_PAIR_TIMEOUT_MS}ms`)), PER_PAIR_TIMEOUT_MS),
  );
  const work = (async () => {
    await Promise.all([sender.openOrError, receiver.openOrError]);
    await Promise.all([sender.peerReady, receiver.peerReady]);

    const chunk = Buffer.alloc(CHUNK);
    let sent = 0;
    while (sent < totalBytes) {
      const n = Math.min(CHUNK, totalBytes - sent);
      await waitForDrain(sender.ws, SBUF_HIGH);
      sender.ws.send(n === CHUNK ? chunk : chunk.subarray(0, n), { binary: true });
      sent += n;
    }
    await waitForDrain(sender.ws, 0);
    await recvDone;
  })();

  try {
    await Promise.race([work, deadline]);
    return { idx, ok: true, ms: Date.now() - t0 };
  } catch (err) {
    return { idx, ok: false, ms: Date.now() - t0, status: err.message };
  } finally {
    try { sender.ws.close(); } catch {}
    try { receiver.ws.close(); } catch {}
  }
}

async function main() {
  const totalBytes = SIZE_MB * 1024 * 1024;
  const t0 = Date.now();
  console.log(`bench-load: ${PARALLEL}× ${SIZE_MB} MiB → ${RELAY}`);
  let doneCount = 0;
  const promises = Array.from({ length: PARALLEL }, async (_, i) => {
    // Stagger TLS handshakes to avoid a thundering-herd that overwhelms
    // Fly's proxy when ~30+ pairs try to connect simultaneously.
    await new Promise((r) => setTimeout(r, i * 50));
    const r = await transferPair(i, totalBytes);
    doneCount++;
    if (doneCount % 10 === 0 || doneCount === PARALLEL) {
      console.error(`progress: ${doneCount}/${PARALLEL}`);
    }
    return r;
  });
  const results = await Promise.all(promises);
  const wall = Date.now() - t0;
  const ok = results.filter((r) => r.ok).length;
  const fail = results.length - ok;
  const totalMb = PARALLEL * SIZE_MB;
  const aggMbps = (totalMb * 8) / (wall / 1000);
  console.log(`\n=== ${PARALLEL}× ${SIZE_MB} MiB ===`);
  console.log(`  ok=${ok}/${results.length} fail=${fail}`);
  console.log(`  wall: ${(wall / 1000).toFixed(1)}s | aggregate: ${aggMbps.toFixed(0)} Mbps (${(aggMbps / 8).toFixed(1)} MB/s)`);
  for (const r of results) {
    if (r.ok) console.log(`  [${r.idx}] ✓ ${(r.ms / 1000).toFixed(1)}s`);
    else      console.log(`  [${r.idx}] ✗ ${(r.ms / 1000).toFixed(1)}s — ${r.status}`);
  }
  process.exit(fail === 0 ? 0 : 1);
}

main();
