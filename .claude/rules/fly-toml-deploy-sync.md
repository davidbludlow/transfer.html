---
applyTo: 'fly.toml'
paths:
  - 'fly.toml'
description: When fly.toml changes, update the reference copy in deploy.md too.
---

# Keep deploy.md's reference fly.toml in sync

`fly.toml` is gitignored (it's per-deploy: app name, region, machine size).
The only "shared" copy of it lives in `deploy.md` as a reference fenced
code block under a heading like "Reference fly.toml".

If you edit `fly.toml`, also update that block in `deploy.md` so the
maintainer (and any future contributor reading the repo) can reproduce
the same configuration. The two should match line-for-line.

If a change in `fly.toml` is intentionally local-only (e.g., experimental
testing) and shouldn't be reflected in the canonical reference, say so
explicitly to the user before deciding not to update `deploy.md`.
