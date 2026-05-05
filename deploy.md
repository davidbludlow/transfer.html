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
- `fly.toml` — minimal Fly app config. The `app =` line contains a placeholder name you must replace with something globally unique on Fly.io (e.g. `MYUSER-transfer-relay`).

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

### 3. Edit the app name

Open `fly.toml` and replace `CHANGE-ME-transfer-relay` with a globally unique name (hyphens fine, no underscores).

Optionally change `primary_region` from `"iad"` (US East) to a region closer to where you'll use it: `"ams"` (Amsterdam), `"fra"` (Frankfurt), `"sin"` (Singapore), `"nrt"` (Tokyo), etc. Run `fly platform regions` for the full list.

### 4. Launch

In the project root:

```sh
fly launch --copy-config --no-deploy --yes
```

This reads `fly.toml`, registers the app, and stops short of deploying.

### 5. Deploy

```sh
fly deploy --ha=false
```

Fly builds the Docker image remotely (you do not need Docker installed) and rolls out a single machine. After ~60-90s it prints the URL.

**The `--ha=false` flag is critical.** Without it, Fly defaults to two machines for high availability. The relay holds rooms in in-memory state, so two clients that land on different machines never see each other and the transfer hangs forever. If you've already deployed without `--ha=false`, fix it with:

```sh
fly scale count 1
```

### 6. Smoke-test

```sh
curl https://YOUR-APP-NAME.fly.dev/
```

Expected output:

```
transfer relay
rooms: 0
```

If the first request takes a few seconds, that's the auto-sleeping machine waking up. Subsequent requests are immediate until it sleeps again (default after ~5 min idle).

### 7. Point `transfer.html` at it

Open `transfer.html` in a browser. In the "relay" field at the top of the page, replace the default `ws://localhost:8080/` with:

```
wss://YOUR-APP-NAME.fly.dev/
```

Or edit `transfer.html` so the deployed URL is the default (the `value` attribute of `<input id="relay">`).

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
