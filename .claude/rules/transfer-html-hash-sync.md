---
applyTo: 'transfer.html'
paths:
  - 'transfer.html'
description: When transfer.html changes, update its SHA-256 in README.md.
---

# Keep README.md's expected hash in sync with transfer.html

`README.md` shows the SHA-256 of `transfer.html` so users can verify their copy against a published value.

If you edit `transfer.html`, run `sha256sum transfer.html` and replace the hash in the fenced code block under "How to verify your copy of the HTML" in `README.md`.
