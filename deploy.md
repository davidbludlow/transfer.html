# Deploying the relay

The relay is a single Deno script with no persistent state. Any host that can run a Deno binary and serve a public WebSocket (with TLS) will work. This file walks through one specific path: deploying to Fly.io on a scale-to-zero machine.

## Cost

Fly.io is **not free** — they retired their always-free tier and now require a credit card. With the scale-to-zero config in `fly.toml`, expected cost for personal use is a few cents a month. Worst case if the machine fails to stop and runs 24/7 is ~$2/month. Fly has no built-in billing cap.

## Why Fly.io as the default recipe

- Cheap for scale-to-zero workloads.
- Remote Docker builds; no local Docker needed.
- HTTPS / WSS terminated automatically.
- One-line redeploy (`fly deploy`).

Other paths (Oracle Cloud Free Tier, Hetzner, a self-hosted box behind Caddy or Cloudflare Tunnel, etc.) are entirely valid and will give you the same end result. Pick what fits your jurisdiction and uptime needs.

## Files in this repo that the recipe uses

- `Dockerfile` — pinned `denoland/deno:alpine-2.7.14` base, copies `relay.ts` + `deno.json` + `deno.lock`, caches with `--frozen` for integrity-checked installs, runs the relay with `--allow-net=0.0.0.0:8080` and `--allow-env` scoped to three optional `npm:ws` config reads.
- `fly.toml` — **not committed**; gitignored. `fly launch` (step 3 below) generates a sensible one for you. A reference copy of the current maintainer's `fly.toml` is at the bottom of this file.

## Recipe

### 1. Install `flyctl`

```sh
curl -L https://fly.io/install.sh | sh
```

This installs to `~/.fly/bin/flyctl` and amends `PATH` in your shell rc. Open a new terminal or `source ~/.zshrc` (or your shell's equivalent) to pick up the change.

To remove later: `rm -rf ~/.fly`.

### 2. Sign up and log in

```sh
fly auth signup
```

Opens a browser. Email + password + a credit card. Fly bills monthly for what you use; see the "Cost" section above for what to expect.

If you already have an account: `fly auth login`.

### 3. Generate `fly.toml` and register the app

In the project root:

```sh
fly launch --no-deploy
```

This auto-detects your geographically-nearest Fly region, prompts for an app name (or generates one), and writes a `fly.toml` to the project root. It does NOT deploy.

If you'd rather skip the prompts: add `--generate-name --copy-config --yes`.

> **Recommended tweak before step 4:** open the generated `fly.toml` and change `memory = '1gb'` (Fly's default) to `memory = '512mb'`. The relay runs fine in 512 MB even under heavy parallel load (256 MB OOMs around ~20 concurrent transfers; 512 MB has comfortable headroom; either is far cheaper than the 1 GB default). The maintainer's `fly.toml` at the bottom of this file shows this and a few other small tweaks.
>
> Optionally also change `primary_region` if you want a region other than the auto-detected nearest. Run `fly platform regions` for the full list.

### 4. Deploy

```sh
fly deploy --ha=false
```

Fly builds the Docker image remotely (you do not need Docker installed) and rolls out a single machine. After ~60-90s it prints the URL.

**The `--ha=false` flag is critical.** Without it, Fly defaults to two machines for high availability. The relay holds rooms in in-memory state, so two clients that land on different machines never see each other and the transfer hangs forever. If you've already deployed without `--ha=false`, fix it with:

```sh
fly scale count 1
```

### 5. Smoke-test

```sh
curl https://YOUR-APP-NAME.fly.dev/
```

Expected output:

```
transfer relay
rooms: 0
```

If the first request takes a few seconds, that's the auto-sleeping machine waking up. Subsequent requests are immediate until it sleeps again (default after ~5 min idle).

### 6. Point `transfer.html` at it

The relay URL is hardcoded in `transfer.html` as the `RELAY_URL` constant near the top of the `<script>` block. Edit it to your deployed URL:

```js
let RELAY_URL = "wss://YOUR-APP-NAME.fly.dev/";
```

For quick testing without re-editing the file, you can override at load time via the `?relay=` query parameter:

```
transfer.html?relay=wss://YOUR-APP-NAME.fly.dev/
```

## Optional: monthly byte cap (sidecar)

Without a cap, a sustained transfer (or a bad actor) can run up Fly egress charges with no ceiling. `worker/sidecar.js` is a Cloudflare Worker that holds a monthly byte counter in Workers KV; the relay checks it before accepting connections and reports byte deltas as the transfer proceeds. Free at any reasonable volume (well under Workers' 100K req/day and KV's 1K writes/day with a 60-second flush interval).

Steps:

```sh
npm install -g wrangler
wrangler login

# Inside the repo, create a wrangler.toml that points at worker/sidecar.js.
# Sketch (fill in the KV namespace id after the create command below):
#
#   name = "transfer-html-sidecar"
#   main = "worker/sidecar.js"
#   compatibility_date = "2026-05-31"
#   [vars]
#   MONTHLY_CAP_BYTES = "2500000000000"   # 2.5 TB → ~$50/mo at Fly's $0.02/GB
#   [[kv_namespaces]]
#   binding = "USAGE_KV"
#   id = "<from `wrangler kv namespace create USAGE_KV`>"
#
# wrangler.toml is gitignored because it's per-deploy.

wrangler kv namespace create USAGE_KV
wrangler secret put REPORT_TOKEN    # any random string ≥32 chars
wrangler deploy

# Wire the relay to the sidecar (Fly secrets so they're not in fly.toml):
fly secrets set \
  SIDECAR_URL="https://transfer-html-sidecar.YOUR-CLOUDFLARE-ACCOUNT.workers.dev" \
  SIDECAR_TOKEN="<same value you set as REPORT_TOKEN above>"

# Add the sidecar host to relay.ts's --allow-net in the Dockerfile CMD,
# then re-deploy:
#   --allow-net=0.0.0.0:8080,transfer-html-sidecar.YOUR-ACCOUNT.workers.dev:443
fly deploy
```

When the cap is hit, the relay returns WebSocket close code 1008 ("monthly cap reached") on new upgrades. The cap resets at the start of each calendar month. Sidecar unreachable → relay continues accepting connections (fail-open) and reports queue up locally to be flushed when the sidecar comes back.

## Future deploys

After any change to `relay.ts` or the Dockerfile:

```sh
fly deploy
```

That's it. Fly handles versioning, rollbacks (`fly releases list`, `fly deploy --image <previous>`), and zero-downtime swaps automatically.

## Removing the deployment

```sh
fly apps destroy YOUR-APP-NAME --yes
```

Removes the app and all its machines. To pause without destroying:

```sh
fly scale count 0
```

## Things that may bite you

- **The relay must run as a single machine.** Rooms are held in in-memory state, so two clients on different machines never meet. Use `--ha=false` on first deploy or `fly scale count 1` after the fact. This is the single most likely thing to bite you.
- **`auto_stop_machines` syntax has changed historically.** Recent versions accept `"stop"`; older versions wanted `true`. If `fly deploy` rejects the toml, swap the value and retry.
- **WebSocket idle timeouts.** Fly's edge proxy will close idle WebSockets after some minutes. Our protocol is fast and short-lived so this rarely matters, but if you ever transfer a multi-GB file at slow speeds and it stalls, that may be why.
- **Logs may briefly show client IPs.** The relay does not log them, but Fly's edge layer does. If client-IP exposure to the host is in your threat model, host somewhere you control (Hetzner, Oracle, self-hosted) and turn off proxy access logs.

## Verification checklist after deploy

- `curl https://YOUR-APP-NAME.fly.dev/` returns `transfer relay\nrooms: 0\n`.
- `transfer.html` with relay URL set to `wss://YOUR-APP-NAME.fly.dev/` successfully round-trips a small text message between two browser tabs.
- Computing the SHA-256 of `transfer.html` matches the value you recorded for your trusted copy.

## Reference `fly.toml`

`fly.toml` is gitignored so the repo stays portable. Below is the maintainer's current `fly.toml`. Useful as a starting point if you want to mirror these settings, as a quick recovery if you lose your local file, and as a way to track historical changes via this file's git history.

If you change your local `fly.toml`, update this block to match (there's a `.claude/rules/fly-toml-deploy-sync.md` rule that reminds AI assistants to do this).

```toml
# fly.toml app configuration file generated for davidbludlow-transfer-html-relay on 2026-04-30T14:58:59-06:00
#
# See https://fly.io/docs/reference/configuration/ for information about how to use this file.
#

app = 'davidbludlow-transfer-html-relay'
primary_region = 'sjc'

[build]

[http_service]
  internal_port = 8080
  force_https = true
  auto_stop_machines = 'stop'
  auto_start_machines = true
  min_machines_running = 0

[[vm]]
  size = 'shared-cpu-1x'
  memory = '512mb'
```
