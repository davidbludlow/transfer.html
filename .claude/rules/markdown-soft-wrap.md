---
applyTo: '**/*.md'
paths:
  - '**/*.md'
description: Markdown files use soft-wrap (one paragraph = one line). Don't hard-wrap.
---

Soft-wrap: each paragraph is one long line; let the editor wrap it visually. Same for list items and blockquote paragraphs. Code blocks, tables, and headings stay verbatim.

Auto-reflow tools have bitten this repo before — they've collapsed multi-paragraph blockquotes into one and merged indented code blocks into their list items. If you bulk-reflow, eyeball each file afterward.
