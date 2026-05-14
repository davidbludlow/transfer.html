# Cost and performance research findings

These are findings from one investigation session in May 2026, comparing the four production-architecture variants of `transfer.html` (the branches `main`, `experiment-webrtc-with-fallback`, `experiment-cloudflare-turn`, `experiment-cloudflare-turn-only`) against each other and against the croc tool. Not authoritative documentation — pricing and provider behavior changes, and these numbers are point-in-time. Re-verify before betting deployment decisions on them.

## Throughput measurements

All numbers are end-to-end (sender click → receiver "ok"), measured via Playwright with Chromium against deployed infrastructure where applicable.

| Path | Test size | Time | Throughput |
|---|---|---|---|
| `main` over deployed Fly relay (sjc) | 1 GiB | 1.2 min | ~14 MB/s sustained |
| `experiment-cloudflare-turn-only` over Cloudflare TURN | 1 GiB | 7.8 min | ~2.2 MB/s sustained |
| `experiment-cloudflare-turn` local-loopback P2P (both browsers on same VM) | 4 GiB | 58 s | ~70 MB/s sustained |
| `experiment-cloudflare-turn` local-loopback P2P | 12 GiB | 2.9 min | ~70 MB/s sustained |
| `croc` v10.4.2 over its public relay (`croc.schollz.com`) | 1 GiB | 33.7 s | ~45 MB/s sustained |
| `croc` v10.4.2 same-machine (direct local TCP) | 1 GiB | 9.3 s | ~270 MB/s |

Why croc beats transfer.html at every transport level:

1. **Native Go vs JavaScript/V8.** Encryption, file I/O, and chunk processing all run faster outside the browser.
2. **Raw TCP vs WebRTC DataChannel.** RTCDataChannel adds DTLS + SCTP framing + browser-level flow control per message. Loopback amplifies the per-message overhead.
3. **Parallel TCP streams** (default `--transfers 4` in croc) — each stream gets its own congestion window.
4. **No Web Crypto boundary.** transfer.html crosses into Web Crypto per 64 KiB chunk; croc's AES is native.

## Why Cloudflare TURN tops out so low

The 2.2 MB/s on the TURN-only path is below Cloudflare's documented 50–100 Mbps per-allocation cap. We swept the `WS_BUFFER_HIGH` threshold (4, 8, 12, 16, 32 MB) and tried event-driven `bufferedamountlow` instead of 25 ms polling — no app-level fix changed throughput. The binding constraint is the SCTP drain rate across a two-hop TURN path (peer → CF-edge-A → CF-edge-B → peer). Larger application buffers don't help: Chromium's internal SCTP send queue hard-caps around 16 MB and throws `send queue is full` if you push past that.

## Browser memory ceiling for big files (on `experiment-cloudflare-turn`)

Sender holds the file as one `Uint8Array` (~size MB), receiver accumulates chunks until `end` (~size MB). Peak demand ≈ 2× file size of active heap.

| File size | Result |
|---|---|
| 4 GiB | passed (58 s) |
| 6 GiB | passed (1.4 min) |
| 8 GiB | passed (1.8 min) |
| 10 GiB | passed (2.3 min) |
| 12 GiB | passed (2.9 min) |
| 15 GiB | OOM-killed (system has 17 GiB RAM + 25 GiB swap) |

12 GiB is the practical ceiling on this VM; somewhere between 12 and 15 GiB the kernel can't cycle the active heap through swap fast enough.

## Pricing facts (verified May 2026)

- **Fly.io egress:** $0.02/GB in North America and Europe, $0.04/GB elsewhere. No monthly free allowance — every byte billed from byte one. Machine cost with `auto_stop_machines = 'stop'` adds ~$2/month. [Source.](https://fly.io/docs/about/pricing/)
- **Cloudflare Realtime SFU + TURN:** $0.05/GB egress, with a **shared 1,000 GB/month free tier** that covers SFU and TURN combined. The TURN-specific docs page only mentions the SFU-bundling free path; the shared free tier is documented on the [SFU pricing page](https://developers.cloudflare.com/realtime/sfu/pricing/) and confirmed across multiple sources. We only use TURN, so the entire 1 TB free tier is available.
- **Cloudflare Workers + KV:** the credential-minting worker is comfortably inside free plan limits (100K Worker requests/day, 100K KV reads/day, 1K KV writes/day) at any plausible volume for this project.
- **Deno Deploy:** 100 GB free egress/month, then $0.50/GB overage. 1 M free requests/month then $2/M. Not a TURN replacement — it's a JS runtime, can host a WebSocket relay, but at 10× Fly's per-GB rate above the free tier. Also documents that long-lived WebSocket connections can be evicted and signaled with SIGINT during isolate rebalancing — operational hazard for relay use.
- **Hetzner Cloud CX22:** ~€3.79/month (pre-April-2026 rate; possibly $4–5 now). **20 TB/month of egress included** in EU/US locations. €1/TB ($0.001/GB) overage. 2 vCPU / 4 GB RAM / 40 GB SSD. [Source.](https://www.hetzner.com/cloud/pricing/)
- **Oracle Cloud Always Free:** $0/month, **10 TB/month outbound** free, 4 OCPU ARM + 24 GB RAM. Reputation caveats (random idle-resource reclamation, capacity issues in some regions, hostile support).
- **AWS — Kinesis Video Streams WebRTC (managed TURN):** $0.03/channel/month for active signaling channels, $2.25 per million signaling messages, $0.12 per 1,000 TURN streaming minutes. KVS WebRTC has no published per-GB TURN price — billing is per-minute of relayed media — but standard AWS data-transfer-out charges apply on top whenever bytes leave AWS to the internet ($0.09/GB for the first 10 TB after a 100 GB monthly free allowance, dropping to $0.085/GB next 40 TB, $0.07/GB next 100 TB). For a typical 1 GB transfer at ~14 MB/s sustained the relay-minutes piece is ~$0.0001 (≈1.2 min × $0.12/1000) but the egress alone is ~$0.09; for a slow 1 GB transfer that takes 8 minutes you still pay ~$0.09 — egress dominates by three orders of magnitude. [KVS pricing.](https://aws.amazon.com/kinesis/video-streams/pricing/) For this workload AWS KVS WebRTC is disqualified because per-GB egress is 4.5× Fly's rate and 90× Hetzner's overage, with no included allowance large enough to matter.
- **AWS — custom relay on cheapest compute:** EC2 `t4g.nano` is $3.07/month on-demand in us-east-1 (2 vCPU ARM Graviton, 0.5 GB RAM); Lightsail's smallest IPv6-only nano is $3.50/month with **1 TB included transfer**, and the $5/month IPv4 nano also bundles 1 TB. Overage on Lightsail is $0.09/GB; raw EC2 has no bundled transfer beyond the 100 GB free tier and bills at $0.09/GB first 10 TB, $0.085/GB next 40 TB, $0.07/GB next 100 TB, $0.05/GB above 150 TB. At 1 TB/month total cost is ~$5 on Lightsail (in-bundle) vs. ~$85 on t4g.nano (1024-0.1 GB × $0.09 + $3.07 machine); at 5 TB Lightsail jumps to ~$365 ($5 + 4 TB × $0.09/GB). [Lightsail pricing.](https://aws.amazon.com/lightsail/pricing/) [EC2 data transfer.](https://aws.amazon.com/ec2/pricing/on-demand/) For this workload AWS compute is disqualified above ~1 TB because every option converges on $0.09/GB egress — 4.5× Fly and 90× Hetzner.
- **Netlify:** 100 GB bandwidth free, then $55 per 100 GB ($0.55/GB) on Pro ($20/month flat). Edge Functions have a 50 ms CPU / sub-second response budget and explicitly **do not support persistent WebSocket connections** — Netlify's own docs route real-time use cases to third-party services (Pusher, Ably). [Netlify pricing.](https://www.netlify.com/pricing/) For this workload Netlify is disqualified for the relay (no WebSockets in Edge Functions, no other compute primitive that holds a socket open). Static-hosting the HTML on Netlify works fine within the 100 GB free tier, but the file is meant to be loaded from local disk anyway, so there's no real role for Netlify here.
- **Vercel:** 100 GB Fast Data Transfer free on Hobby; Pro is $20/developer/month with 1 TB included and $0.15/GB overage. Vercel Functions (including the Edge runtime, which is built on Cloudflare Workers under the hood) do not host WebSocket servers — every documented path terminates the function after the response, and even with Fluid Compute streaming responses are one-way. Vercel's own KB recommends offloading WebSockets to Ably/Pusher/Partykit/etc. [Vercel pricing.](https://vercel.com/pricing) [Vercel WebSocket KB.](https://vercel.com/kb/guide/do-vercel-serverless-functions-support-websocket-connections) For this workload Vercel is disqualified for the relay (no persistent WebSocket primitive) and uncompetitive for static hosting at scale ($0.15/GB is 7.5× Fly and 150× Hetzner overage).

## Cost crossovers

### Crossover within the project's current architecture choices

Both `experiment-cloudflare-turn` (P2P + CF TURN fallback) and `experiment-webrtc-with-fallback` (P2P + Fly WS fallback) have ~$2/month fixed for the Fly signaling relay. The variable cost is on the fallback bytes only.

| Total monthly bill | Approx. fallback bytes | Cheaper option |
|---|---|---|
| ~$2 | ≤ 100 GB | CF TURN (free tier) |
| ~$10 | ~600 GB | CF TURN by a lot ($10 → $2) |
| ~$22 | ~1 TB | CF TURN by $20 (still in free tier) |
| ~$27 | ~1.3 TB | CF TURN by ~$5 |
| **~$35** | **~1.67 TB** | **TIE — crossover** |
| ~$50 | ~2.4 TB | webrtc-with-fallback by ~$10 |
| ~$200 | ~10 TB | webrtc-with-fallback by ~$200 |

**Plain English:** below about $35/month total bill, Cloudflare TURN is cheaper because its 1 TB free tier eats the fallback cost. Above $35/month, Fly's $0.02/GB beats Cloudflare's $0.05/GB overage.

### Crossover to a VPS

If you self-host on Hetzner CX22:

- Hetzner: ~$4/month fixed, up to 20 TB of egress included
- Fly: $2 + $0.02 × GB
- Crossover with Fly: ~100 GB/month — beyond that, Hetzner wins on raw cost
- Crossover with CF TURN: ~1.04 TB of fallback bytes — beyond that, Hetzner wins; below that, CF TURN is still free

| Monthly egress | Fly only | CF TURN | Hetzner CX22 | Oracle Free |
|---|---|---|---|---|
| 100 GB | $4 | $2 | $4 | $0 |
| 1 TB | $22 | $2 | $4 | $0 |
| 5 TB | $102 | $202 | $4 | $0 |
| 20 TB | $402 | $952 | $4 | not free |
| 50 TB | $1002 | $2452 | $34 | not free |

So at large scale, a VPS is dramatically cheaper than any managed option. The tradeoff is operational burden: self-managed OS, HTTPS termination, monitoring, single-region latency, no auto-scale. Migration is not automatic.

## Transfer.html complexity comparison

| Branch | Lines (HTML+JS) | Δ vs `main` | What's in the delta |
|---|---|---|---|
| `main` | 591 | — | Single WebSocket data path. Simplest. |
| `experiment-cloudflare-turn-only` | 722 | +131 | `fetchIceServers` + `establishPeerConnection`. `iceTransportPolicy: 'relay'` forces all data through TURN. |
| `experiment-cloudflare-turn` | 738 | +147 | Same as `-only`, plus STUN_SERVERS for direct-P2P discovery + STUN-only fallback in `fetchIceServers`. Browser's ICE picks transport automatically. |
| `experiment-webrtc-with-fallback` | 753 | +162 | `establishPeerConnection` + hand-rolled `negotiateTransport` (races P2P against a timeout, sender announces decision, both sides return a unified transport interface for send/recv). |

Deployment burden by branch:

- `main`: just Fly.io
- `experiment-webrtc-with-fallback`: just Fly.io (uses free public STUN; fallback goes through the same Fly relay)
- `experiment-cloudflare-turn` / `-only`: Fly.io + Cloudflare account + TURN App + Worker + KV namespace + Wrangler

## Bugs found and fixed during the investigation

Documented for future reference. All fixes are in the cloudflare-* branch histories.

1. **iceServers shape mismatch.** The Cloudflare TURN credentials endpoint returns an *array* of iceServers entries (one STUN, one TURN). The old `fetchIceServers` wrapped it in another array, leaving `RTCPeerConnection` with `iceServers: [[…]]` — element 0 is an array instead of an iceServer object, and ICE fails to start. Fix: don't wrap, spread when combining with local STUN_SERVERS.
2. **Signaling race in `establishPeerConnection`.** The function used to `await fetchIceServers()` before attaching `ws.onmessage`. The receiver's WebSocket sat with no message handler attached during the 200–500 ms worker fetch; the sender's offer + early ICE candidates arrived during that window and were dropped (WebSocket doesn't queue MessageEvents when no listener is attached at delivery time). Fix: attach the handler synchronously at the top of the function, buffer incoming messages until `pc` exists, drain afterwards.

## Recommendation matrix

For most realistic project sizes:

- **Under ~1 TB of fallback traffic per month:** `experiment-cloudflare-turn` wins. The 1 TB shared SFU+TURN free tier covers everything; total cost is ~$2/month for the Fly signaling relay. The `MONTHLY_CAP` already in `worker/turn-creds.js` provides a hard ceiling.
- **1 – 5 TB fallback range:** the crossover band. `experiment-webrtc-with-fallback` starts beating Cloudflare TURN past ~1.67 TB fallback. A Hetzner CX22 also becomes competitive in this range (~$4 flat vs $30+ on Fly or $50+ on CF after free tier).
- **Above ~5 TB:** managed services become expensive. Hetzner CX22 stays at $4 until you exhaust 20 TB included; Oracle Cloud Free Tier covers 10 TB at $0 if you trust their always-free promise. This is when migration to a VPS makes sense — manual switchover, ~few hours of work.
- **If audit-surface minimalism dominates:** `main` is the smallest at 591 lines. The wire protocol is shared with the WebRTC variants, so migrating later is a transfer.html swap, not a redesign.

## Capping spend

All four architectures support a hard monthly cost cap via a small KV-backed metering sidecar on Deno Deploy or Cloudflare Workers. The pattern:

1. Tracker stores monthly byte total in KV keyed by year-month.
2. Producer (relay or `worker/turn-creds.js`) reports usage deltas.
3. Before authorizing new transfers, query the tracker. If cap reached, return 429.
4. Cap math is approximate (KV is eventually consistent; expect small over-mint near boundaries).

The TURN credentials worker on the cloudflare-* branches already implements this pattern (`MONTHLY_CAP` limits credentials minted, indirectly capping TURN bytes). On `main` or `experiment-webrtc-with-fallback` you'd add a similar sidecar that tracks Fly egress and gates new WebSocket upgrades.

## Things not investigated

- Multiple parallel DataChannels (croc-style multi-stream over a single peer connection). Could improve TURN throughput if Cloudflare's per-allocation cap is per-stream rather than total. Requires wire-protocol change (sequence numbers per chunk for reassembly).
- Multiple parallel peer connections (separate TURN allocations). Larger refactor.
- Alternative TURN providers (Twilio, Xirsys, self-hosted coturn).
- Cloudflare Realtime SFU as the data path. Different architectural model — would change the threat model around traffic analysis.
- Actually deploying to Hetzner / Oracle and measuring real throughput. Pricing tables are theoretical until you've measured a specific provider's network from your users.

## Sources

- [Cloudflare Realtime SFU + TURN pricing](https://developers.cloudflare.com/realtime/sfu/pricing/) — the page that documents the 1,000 GB shared free tier
- [Cloudflare TURN service docs](https://developers.cloudflare.com/realtime/turn/) — TURN-specific endpoints, doesn't mention the free tier
- [Cloudflare Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [Cloudflare TURN credentials API](https://developers.cloudflare.com/realtime/turn/generate-credentials/)
- [Fly.io bandwidth pricing](https://fly.io/docs/about/pricing/)
- [Fly.io cost management — no built-in billing caps](https://fly.io/docs/about/cost-management/)
- [Deno Deploy pricing](https://deno.com/deploy/pricing)
- [Hetzner CX22 pricing & 20 TB included traffic](https://www.hetzner.com/cloud/pricing/)
- [Oracle Cloud Always Free — 10 TB outbound](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)
- [AWS Kinesis Video Streams pricing (signaling + TURN minutes)](https://aws.amazon.com/kinesis/video-streams/pricing/)
- [AWS EC2 on-demand + data transfer pricing](https://aws.amazon.com/ec2/pricing/on-demand/)
- [AWS Lightsail pricing (1 TB bundled transfer)](https://aws.amazon.com/lightsail/pricing/)
- [Netlify pricing & plans](https://www.netlify.com/pricing/)
- [Vercel pricing](https://vercel.com/pricing)
- [Vercel KB — Serverless Functions do not support WebSockets](https://vercel.com/kb/guide/do-vercel-serverless-functions-support-websocket-connections)
- [Wrangler KV commands](https://developers.cloudflare.com/kv/reference/kv-commands/)
- [Croc GitHub issue #289 — relay cost reference (~$25/month for "thousands of users")](https://github.com/schollz/croc/issues/289)
