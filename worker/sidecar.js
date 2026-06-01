// Cloudflare Worker sidecar: monthly byte counter with a hard cap.
//
// The relay POSTs byte deltas to /report and GETs /status before
// accepting new connections. When the counter for the current month
// reaches MONTHLY_CAP_BYTES, /status returns capReached: true and the
// relay refuses new WebSocket upgrades. KV entries are keyed by the
// year-month (e.g. "2026-05") and self-expire after 60 days.
//
// This is the only piece of persistent state the operator runs. It
// holds no user data — only a single integer per month — so a
// compromised sidecar would leak only "this many bytes flowed in
// month X." The relay itself remains process-memory-only.
//
// ## Deploy
//
//   npm install -g wrangler
//   wrangler login
//   # See deploy.md for the wrangler.toml + secret-setting steps.
//   wrangler kv namespace create USAGE_KV
//   wrangler secret put REPORT_TOKEN   # any random string ≥32 chars
//   wrangler deploy
//
// ## Env / secrets (set via wrangler)
//
//   MONTHLY_CAP_BYTES  — bytes allowed per calendar month. Pick this
//                        from your egress budget. E.g. at Fly's
//                        $0.02/GB, a $50/month ceiling is 2,500 * 1e9
//                        = 2.5 TB. Lower if you want more headroom.
//   REPORT_TOKEN       — shared secret the relay sends as Bearer.
//   USAGE_KV           — KV namespace binding for the monthly counter.
//
// ## Concurrency note
//
// KV read-modify-write under concurrent reports can lose updates
// (eventual consistency). Acceptable here: an under-count means the
// operator might exceed the cap by a small margin near the boundary,
// not that a malicious actor can blow through it.

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const KV_TTL_SECONDS = 60 * 24 * 60 * 60; // 60 days

function currentMonthKey() {
  return new Date().toISOString().slice(0, 7); // "YYYY-MM"
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...CORS_HEADERS },
  });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const cap = parseInt(env.MONTHLY_CAP_BYTES || "0", 10);
    const monthKey = currentMonthKey();
    const used = parseInt((await env.USAGE_KV.get(monthKey)) || "0", 10);
    const url = new URL(request.url);

    if (url.pathname === "/status" && request.method === "GET") {
      return jsonResponse({ used, cap, capReached: used >= cap });
    }

    if (url.pathname === "/report" && request.method === "POST") {
      const auth = request.headers.get("Authorization") || "";
      if (auth !== `Bearer ${env.REPORT_TOKEN}`) {
        return jsonResponse({ error: "unauthorized" }, 401);
      }
      let payload;
      try { payload = await request.json(); } catch { payload = null; }
      const delta = payload && payload.bytes;
      if (typeof delta !== "number" || delta < 0 || !Number.isFinite(delta)) {
        return jsonResponse({ error: "bad bytes" }, 400);
      }
      const newTotal = used + delta;
      await env.USAGE_KV.put(monthKey, String(newTotal), {
        expirationTtl: KV_TTL_SECONDS,
      });
      return jsonResponse({ used: newTotal, cap, capReached: newTotal >= cap });
    }

    return jsonResponse({ error: "not found" }, 404);
  },
};
