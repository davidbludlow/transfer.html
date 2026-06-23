// transfer relay (Deno + npm:ws)
//
// A dumb WebSocket forwarder. Two clients connect to the same room ID
// and the relay splices their message streams together. The relay
// never sees plaintext — clients encrypt with a key derived from a
// shared secret that the relay never sees.
//
// Optionally integrates with `worker/sidecar.js` to enforce a hard
// monthly byte cap. Without SIDECAR_URL set, the relay runs uncapped
// (suitable for self-hosters who don't need cost protection). With it
// set, the relay checks the sidecar's /status before accepting new
// connections and POSTs byte deltas to /report on a flush interval.
// The sidecar holds only an integer monthly counter — no user data —
// so the "no persistence in the relay" rule (see CLAUDE.md) still
// applies to the relay's own process state.
//
// Run:    deno run --allow-net=0.0.0.0:8080 \
//                  --allow-env=WS_NO_BUFFER_UTIL,WS_NO_UTF_8_VALIDATE,NODE_ENV,SIDECAR_URL,SIDECAR_TOKEN \
//                  relay.ts [port]
//
// To enable the sidecar, also add its host to --allow-net (e.g.
// `--allow-net=0.0.0.0:8080,your-sidecar.workers.dev:443`) and set
// SIDECAR_URL and SIDECAR_TOKEN env vars.

import { WebSocketServer } from "npm:ws@8.20.0";
import http from "node:http";

const PORT = Number(Deno.args[0]) || 8080;
const ROOM_TTL_MS = 5 * 60 * 1000;
const PEER_BUFFER_HIGH = 4 * 1024 * 1024; // pause source recv above this
const PEER_BUFFER_LOW = 1 * 1024 * 1024;  // resume source recv below this

// ---------- sidecar (optional) ----------
// Reports forwarded bytes to an external counter and refuses new
// connections once the cap is hit. Disabled when SIDECAR_URL is unset.
// Failure-mode: fail-open (a flaky sidecar lets transfers continue
// uncapped, which is the lesser harm vs. denying service spuriously).
// Read defensively: if the env var isn't in --allow-env scope, Deno
// throws. Treat that as "metering disabled" rather than crashing.
function readEnv(name: string): string {
  try { return Deno.env.get(name) || ""; } catch { return ""; }
}
const SIDECAR_URL = readEnv("SIDECAR_URL");
const SIDECAR_TOKEN = readEnv("SIDECAR_TOKEN");
const SIDECAR_FLUSH_MS = 60 * 1000;

let pendingBytes = 0;
let capReached = false;

async function checkCap() {
  if (!SIDECAR_URL) return false;
  try {
    const res = await fetch(`${SIDECAR_URL}/status`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return false;
    const { capReached: cap } = await res.json();
    capReached = !!cap;
    return capReached;
  } catch {
    return false; // sidecar unreachable → fail-open
  }
}

async function flushBytes() {
  if (!SIDECAR_URL || pendingBytes === 0) return;
  const bytes = pendingBytes;
  pendingBytes = 0;
  try {
    const res = await fetch(`${SIDECAR_URL}/report`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${SIDECAR_TOKEN}`,
      },
      body: JSON.stringify({ bytes }),
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const { capReached: cap } = await res.json();
      capReached = !!cap;
    } else {
      pendingBytes += bytes; // failed; replay on next flush
    }
  } catch {
    pendingBytes += bytes; // unreachable; replay on next flush
  }
}

if (SIDECAR_URL) {
  setInterval(flushBytes, SIDECAR_FLUSH_MS);
  console.log(`metering enabled via sidecar: ${SIDECAR_URL}`);
}

const rooms = new Map();

function notifyPeerReady(room) {
  if (room.clients.length !== 2) return;
  if (!room.clients.every((c) => c.readyState === c.OPEN)) return;
  for (const c of room.clients) {
    try { c.send(JSON.stringify({ ev: "peer" })); } catch { /* ignore */ }
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [id, room] of rooms) {
    if (now - room.createdAt > ROOM_TTL_MS && room.clients.length < 2) {
      for (const ws of room.clients) {
        try { ws.close(1000, "room ttl"); } catch { /* ignore */ }
      }
      rooms.delete(id);
    }
  }
}, 30_000);

// Serve the client page at "/" if transfer.html is readable; otherwise stay a
// pure relay. (ws upgrades hit the "upgrade" handler below, not this one.)
let page = "";
try { page = Deno.readTextFileSync("transfer.html"); } catch { /* page serving disabled */ }

const server = http.createServer((req, res) => {
  const path = req.url.split("?")[0];
  if (page && (path === "/" || path === "/index.html" || path === "/transfer.html")) {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(page);
    return;
  }
  res.writeHead(200, { "content-type": "text/plain" });
  res.end(`transfer relay\nrooms: ${rooms.size}\n`);
});

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", async (req, socket, head) => {
  const roomId = new URLSearchParams(req.url.split("?")[1]).get("room");
  if (!roomId || !/^[A-Za-z0-9_-]{1,128}$/.test(roomId)) {
    socket.destroy();
    return;
  }

  // Sidecar gate: refuse new connections when the monthly cap is hit.
  // Uses the cached value first to avoid a fetch on every upgrade; only
  // re-checks if the cached value says "not capped" (a stale "capped"
  // value would deny service, so we trust the gate-side check).
  if (capReached || await checkCap()) {
    wss.handleUpgrade(req, socket, head, (ws) => {
      try { ws.close(1008, "monthly cap reached"); } catch { /* ignore */ }
    });
    return;
  }

  let room = rooms.get(roomId);
  if (!room) {
    room = { clients: [], createdAt: Date.now() };
    rooms.set(roomId, room);
  }
  if (room.clients.length >= 2) {
    // Complete the WS handshake then immediately close with code 1008 so
    // clients can distinguish "room full" from a generic network error.
    wss.handleUpgrade(req, socket, head, (ws) => {
      try { ws.close(1008, "room full"); } catch { /* ignore */ }
    });
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    room.clients.push(ws);
    notifyPeerReady(room);

    let chain = Promise.resolve();
    let pending = 0;

    ws.on("message", (data, isBinary) => {
      const peer = room.clients.find((c) => c !== ws);
      if (!peer || peer.readyState !== peer.OPEN) return;

      pending++;
      if (pending > 1) ws.pause();
      pendingBytes += data.byteLength; // sidecar metering

      chain = chain.then(() =>
        new Promise((resolve) => {
          peer.send(data, { binary: isBinary }, () => resolve());
        }).then(async () => {
          while (
            peer.bufferedAmount > PEER_BUFFER_LOW &&
            peer.readyState === peer.OPEN
          ) {
            await new Promise((r) => setTimeout(r, 5));
          }
          pending--;
          if (pending === 0) ws.resume();
        }),
      );

      if (peer.bufferedAmount > PEER_BUFFER_HIGH) ws.pause();
    });

    ws.on("close", () => {
      room.clients = room.clients.filter((c) => c !== ws);
      if (room.clients.length === 0) {
        rooms.delete(roomId);
      } else {
        for (const peer of room.clients) {
          try { peer.close(1000, "peer left"); } catch { /* ignore */ }
        }
      }
      // Flush metered bytes opportunistically on connection close so a
      // burst-then-idle transfer doesn't sit uncounted until the next
      // interval tick.
      void flushBytes();
    });

    ws.on("error", () => { /* close handler runs after */ });
  });
});

// Bind explicitly to 0.0.0.0 rather than letting Node default to dual-stack
// [::]:PORT, which falls outside the --allow-net=0.0.0.0:8080 permission scope
// and stops the relay from listening at all on runtimes that default that way.
server.listen(PORT, "0.0.0.0", () => {
  console.log(`transfer relay listening on :${PORT}`);
});
