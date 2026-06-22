// Deliberately-malicious WebSocket relay — test-only, NOT part of the product.
//
// It mirrors relay.ts's room rendezvous and peer-ready signalling, but tampers
// with the binary frames it forwards from sender to receiver. Each attack mode
// models a hostile relay trying to make the receiver reconstruct something
// other than what the sender sent. The integrity property under test is that
// every one of these makes the receiver's decryption fail (or the transfer
// abort) rather than silently accept altered bytes — because each frame is
// AES-GCM-authenticated against its type and its position in the stream.
//
// Used by tests/specs/malicious-relay.spec.ts. Run directly with e.g.
//   deno run --allow-net=127.0.0.1 malicious-relay.ts --port=8101 --attack=reorder
//
// Attacks all target the 2nd chunk frame, so the file under test must be at
// least two chunks (128 KiB).

const args = new Map<string, string>();
for (const a of Deno.args) {
  const m = a.match(/^--([^=]+)=(.*)$/);
  if (m) args.set(m[1], m[2]);
}
const PORT = Number(args.get("port") || "8101");
const ATTACK = args.get("attack") || "none";

const TYPE_CHUNK = 2;
const TYPE_END = 3;

interface Room {
  clients: WebSocket[];
  chunksSeen: number; // count of chunk frames forwarded so far (sender -> receiver)
  attackDone: boolean;
  held: Uint8Array | null; // a frame withheld for the reorder attack
  truncating: boolean;
}

const rooms = new Map<string, Room>();

function toBytes(data: ArrayBuffer | Uint8Array): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

function notifyPeerReady(room: Room) {
  if (room.clients.length !== 2) return;
  if (!room.clients.every((c) => c.readyState === WebSocket.OPEN)) return;
  for (const c of room.clients) {
    try { c.send(JSON.stringify({ ev: "peer" })); } catch { /* ignore */ }
  }
}

function send(peer: WebSocket, bytes: Uint8Array) {
  try { peer.send(bytes); } catch { /* peer may have closed */ }
}

// Forward one binary frame from sender to receiver, applying the attack.
// The 2nd chunk frame is the target; everything else passes through.
function forwardBinary(room: Room, peer: WebSocket, bytes: Uint8Array) {
  if (room.truncating) return; // truncate attack: swallow the rest of the stream

  const isChunk = bytes[0] === TYPE_CHUNK;
  if (isChunk) room.chunksSeen++;
  const isTarget = isChunk && room.chunksSeen === 2 && !room.attackDone;

  switch (ATTACK) {
    case "reorder":
      // Hold the 1st chunk, then emit the 2nd before it. The 2nd chunk now
      // lands at the 1st chunk's position; its sequence number no longer
      // matches and decryption fails.
      if (isChunk && room.held === null && room.chunksSeen === 1 && !room.attackDone) {
        room.held = bytes.slice();
        return;
      }
      if (isTarget && room.held) {
        room.attackDone = true;
        send(peer, bytes);
        send(peer, room.held);
        room.held = null;
        return;
      }
      break;
    case "duplicate":
      if (isTarget) {
        room.attackDone = true;
        send(peer, bytes);
        send(peer, bytes); // replay — the copy lands at the next position
        return;
      }
      break;
    case "drop":
      if (isTarget) {
        room.attackDone = true;
        return; // swallow it; the following chunk shifts into its position
      }
      break;
    case "relabel":
      if (isTarget) {
        room.attackDone = true;
        const tampered = bytes.slice();
        tampered[0] = TYPE_END; // relabel a chunk as the end marker
        send(peer, tampered);
        return;
      }
      break;
    case "truncate":
      if (isTarget) {
        room.attackDone = true;
        room.truncating = true;
        return; // drop this chunk and everything after it, including `end`
      }
      break;
  }
  send(peer, bytes); // faithful forward
}

function handleConnection(socket: WebSocket, roomId: string) {
  let room = rooms.get(roomId);
  if (!room) {
    room = { clients: [], chunksSeen: 0, attackDone: false, held: null, truncating: false };
    rooms.set(roomId, room);
  }
  const r = room;

  socket.onopen = () => {
    r.clients.push(socket);
    notifyPeerReady(r);
  };
  socket.onmessage = (e) => {
    const peer = r.clients.find((c) => c !== socket);
    if (!peer || peer.readyState !== WebSocket.OPEN) return;
    if (typeof e.data === "string") {
      try { peer.send(e.data); } catch { /* ignore */ }
      return;
    }
    forwardBinary(r, peer, toBytes(e.data));
  };
  socket.onclose = () => {
    r.clients = r.clients.filter((c) => c !== socket);
    for (const peer of r.clients) {
      try { peer.close(1000, "peer left"); } catch { /* ignore */ }
    }
    if (r.clients.length === 0) rooms.delete(roomId);
  };
  socket.onerror = () => { /* close handler runs after */ };
}

Deno.serve(
  { port: PORT, hostname: "127.0.0.1", onListen: () => console.log(`malicious relay (${ATTACK}) on :${PORT}`) },
  (req) => {
    const roomId = new URL(req.url).searchParams.get("room");
    if (!roomId || !/^[A-Za-z0-9_-]{1,128}$/.test(roomId)) {
      return new Response("bad room", { status: 400 });
    }
    if (req.headers.get("upgrade") !== "websocket") {
      return new Response("malicious test relay", { status: 200 });
    }
    const { socket, response } = Deno.upgradeWebSocket(req);
    handleConnection(socket, roomId);
    return response;
  },
);
