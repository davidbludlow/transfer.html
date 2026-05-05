// transfer relay (Deno + npm:ws)
//
// Same logic as the Node version on experiment-smarter-relay, but
// running under Deno via the `npm:` specifier. Kept as a separate
// branch to compare runtime overhead head-to-head against pure Node.
//
// Run:    deno run --allow-net=0.0.0.0:8080 \
//                  --allow-env=WS_NO_BUFFER_UTIL,WS_NO_UTF_8_VALIDATE,NODE_ENV \
//                  relay.ts [port]

import { WebSocketServer } from "npm:ws@8.20.0";
import http from "node:http";

const PORT = Number(Deno.args[0]) || 8080;
const ROOM_TTL_MS = 5 * 60 * 1000;
const PEER_BUFFER_HIGH = 4 * 1024 * 1024; // pause source recv above this
const PEER_BUFFER_LOW = 1 * 1024 * 1024;  // resume source recv below this

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

const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end(`transfer relay\nrooms: ${rooms.size}\n`);
});

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const roomId = new URLSearchParams(req.url.split("?")[1]).get("room");
  if (!roomId || !/^[A-Za-z0-9_-]{1,128}$/.test(roomId)) {
    socket.destroy();
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
    });

    ws.on("error", () => { /* close handler runs after */ });
  });
});

server.listen(PORT, () => {
  console.log(`transfer relay listening on :${PORT}`);
});
