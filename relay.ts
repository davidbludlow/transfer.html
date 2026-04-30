// xfr relay
//
// A dumb WebSocket forwarder. Two clients connect to the same room ID and
// the relay splices their message streams together. The relay never sees
// plaintext: clients encrypt with a key derived from a shared secret that
// the relay never sees.
//
// Run:    deno run --allow-net=0.0.0.0:8080 relay.ts [port]
// Default port is 8080. Set XFR_PORT env to override (also needs --allow-env).

const PORT = Number(Deno.args[0]) || 8080;
const ROOM_TTL_MS = 5 * 60 * 1000;
const MAX_ROOM_ID_LEN = 128;

interface Room {
  clients: WebSocket[];
  createdAt: number;
}

const rooms = new Map<string, Room>();

function notifyPeerReady(room: Room) {
  if (room.clients.length !== 2) return;
  if (!room.clients.every((c) => c.readyState === WebSocket.OPEN)) return;
  for (const c of room.clients) {
    try {
      c.send(JSON.stringify({ ev: "peer" }));
    } catch {
      // ignore — peer left mid-notify
    }
  }
}

function cleanup() {
  const now = Date.now();
  for (const [id, room] of rooms) {
    if (now - room.createdAt > ROOM_TTL_MS && room.clients.length < 2) {
      for (const ws of room.clients) {
        try {
          ws.close(1000, "room ttl");
        } catch { /* ignore */ }
      }
      rooms.delete(id);
    }
  }
}
setInterval(cleanup, 30_000);

Deno.serve({ port: PORT }, (req) => {
  const url = new URL(req.url);

  if (req.headers.get("upgrade") !== "websocket") {
    return new Response(
      `xfr relay\nrooms: ${rooms.size}\n`,
      { status: 200, headers: { "content-type": "text/plain" } },
    );
  }

  const roomId = url.searchParams.get("room");
  if (!roomId || !/^[A-Za-z0-9_-]{1,128}$/.test(roomId)) {
    return new Response("bad room id", { status: 400 });
  }

  const { socket, response } = Deno.upgradeWebSocket(req);

  let room = rooms.get(roomId);
  if (!room) {
    room = { clients: [], createdAt: Date.now() };
    rooms.set(roomId, room);
  }

  if (room.clients.length >= 2) {
    socket.addEventListener("open", () => {
      try {
        socket.close(1008, "room full");
      } catch { /* ignore */ }
    });
    return response;
  }

  room.clients.push(socket);

  socket.addEventListener("open", () => notifyPeerReady(room!));

  socket.addEventListener("message", (e) => {
    const peer = room!.clients.find((c) => c !== socket);
    if (peer && peer.readyState === WebSocket.OPEN) {
      peer.send(e.data);
    }
  });

  socket.addEventListener("close", () => {
    room!.clients = room!.clients.filter((c) => c !== socket);
    if (room!.clients.length === 0) {
      rooms.delete(roomId);
    } else {
      for (const peer of room!.clients) {
        try {
          peer.close(1000, "peer left");
        } catch { /* ignore */ }
      }
    }
  });

  socket.addEventListener("error", () => {
    // close handler will run after this
  });

  return response;
});

console.log(`xfr relay listening on :${PORT}`);
