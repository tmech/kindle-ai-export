---
name: Kindle library search and selection
agent: kindle-tools
description: Download the current Kindle library list, filter by query, and return a numbered shortlist with ASINs for selection.
tools: ['read', 'search', 'execute', 'todo']
---

# Task

1. Run `pnpm kindle:library`.
2. If a query is provided, rerun with `--query "<query>" --limit <n>` as needed.
3. Read `out/kindle-library.json` and `out/kindle-library.md`.
4. Return a concise numbered list: `Title — Author (ASIN)`.
5. Ask the user to choose one item by number/ASIN if not already specified.
