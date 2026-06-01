// Integration test for relay.ts
// Spawns the relay, opens two WebSocket clients in the same room,
// verifies peer-ready notification + message forwarding + cleanup.
//
// Run from the tests/ directory:
//   cd tests && deno run --allow-net=127.0.0.1 --allow-run=deno test-relay.ts

const PORT = 18080;
const URL = `ws://127.0.0.1:${PORT}/`;

// spawn relay (lives one directory up from this script)
const relay = new Deno.Command("deno", {
  args: [
    "run",
    `--allow-net=0.0.0.0:${PORT}`,
    "--allow-env=WS_NO_BUFFER_UTIL,WS_NO_UTF_8_VALIDATE,NODE_ENV,SIDECAR_URL,SIDECAR_TOKEN",
    "../relay.ts",
    String(PORT),
  ],
  stdout: "piped",
  stderr: "piped",
}).spawn();

// wait for relay to be ready
await new Promise((r) => setTimeout(r, 800));

// Tagged client that buffers messages until consumed.
// Avoids the "listener attached after event fired" race.
type TaggedWS = {
  ws: WebSocket;
  msgs: (string | ArrayBuffer)[];
  msgWaiters: ((m: string | ArrayBuffer) => void)[];
  closeP: Promise<CloseEvent>;
  openP: Promise<void>;
};

function ws(roomId: string): TaggedWS {
  const w = new WebSocket(`${URL}?room=${roomId}`);
  w.binaryType = "arraybuffer";
  // Catch errors so they don't surface as uncaught rejections; close event
  // fires regardless and tests rely on closeP.
  w.addEventListener("error", () => {});
  const t: TaggedWS = {
    ws: w,
    msgs: [],
    msgWaiters: [],
    openP: new Promise<void>((res, rej) => {
      w.addEventListener("open", () => res(), { once: true });
      w.addEventListener("close", () => rej(new Error("closed before open")), { once: true });
    }),
    closeP: new Promise<CloseEvent>((res) => {
      w.addEventListener("close", (e) => res(e as CloseEvent), { once: true });
    }),
  };
  w.addEventListener("message", (e) => {
    if (t.msgWaiters.length > 0) {
      const waiter = t.msgWaiters.shift()!;
      waiter(e.data);
    } else {
      t.msgs.push(e.data);
    }
  });
  return t;
}

function nextMsg(t: TaggedWS): Promise<string | ArrayBuffer> {
  if (t.msgs.length > 0) return Promise.resolve(t.msgs.shift()!);
  return new Promise((res) => t.msgWaiters.push(res));
}

let failures = 0;
function check(label: string, cond: boolean, detail = "") {
  console.log(cond ? `  ok   ${label}` : `  FAIL ${label}${detail ? " — " + detail : ""}`);
  if (!cond) failures++;
}

try {
  console.log("test 1: two clients, peer-ready, message forwarding");
  {
    const a = ws("test1");
    await a.openP;
    const b = ws("test1");
    await b.openP;

    const aData = JSON.parse(await nextMsg(a) as string);
    const bData = JSON.parse(await nextMsg(b) as string);
    check("a got peer-ready", aData.ev === "peer");
    check("b got peer-ready", bData.ev === "peer");

    // a sends binary, b receives
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    a.ws.send(payload);
    const got = new Uint8Array(await nextMsg(b) as ArrayBuffer);
    check(
      "binary forwarded a->b",
      got.length === 5 && got[0] === 1 && got[4] === 5,
      `got [${Array.from(got).join(",")}]`,
    );

    // b sends back
    b.ws.send(new Uint8Array([9, 9]));
    const back = new Uint8Array(await nextMsg(a) as ArrayBuffer);
    check(
      "binary forwarded b->a",
      back.length === 2 && back[0] === 9,
    );

    a.ws.close();
    b.ws.close();
    await new Promise((r) => setTimeout(r, 100));
  }

  console.log("\ntest 2: third client to full room is rejected");
  {
    const a = ws("test2");
    await a.openP;
    const b = ws("test2");
    await b.openP;
    await nextMsg(a); // peer-ready
    await nextMsg(b);

    const c = ws("test2");
    const closed = await c.closeP;
    check(
      "third client closed",
      closed.code === 1008 || closed.reason === "room full",
      `code=${closed.code} reason="${closed.reason}"`,
    );

    a.ws.close();
    b.ws.close();
    await new Promise((r) => setTimeout(r, 100));
  }

  console.log("\ntest 3: when one peer leaves, other is closed");
  {
    const a = ws("test3");
    await a.openP;
    const b = ws("test3");
    await b.openP;
    await nextMsg(a);
    await nextMsg(b);

    a.ws.close();
    const closed = await b.closeP;
    check("peer closed when other left", closed.code === 1000);
  }

  console.log("\ntest 4: bad room id rejected on upgrade");
  {
    const w = ws("");
    // bad room: relay returns 400 -> upgrade fails
    // openP rejects (we catch it); closeP resolves with the close event
    w.openP.catch(() => {});
    const closed = await w.closeP;
    check("bad room rejected", closed.code !== 1000, `code=${closed.code}`);
  }
} finally {
  // shut down relay
  relay.kill("SIGTERM");
  try {
    await relay.status;
  } catch { /* ignore */ }
}

console.log(`\n${failures === 0 ? "PASS" : `FAIL (${failures} failures)`}`);
Deno.exit(failures === 0 ? 0 : 1);
