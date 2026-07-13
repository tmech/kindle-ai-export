---
name: Extract Kindle book pages and metadata
agent: kindle-tools
description: Run Kindle extraction for a selected ASIN and persist pages/metadata.
tools: ['read', 'search', 'execute', 'todo']
---

# Task

1. Confirm `ASIN` and required env vars (`AMAZON_EMAIL`, `AMAZON_PASSWORD`).
2. Run `npx tsx src/extract-kindle-book.ts`.
3. Verify outputs in `out/<ASIN>/metadata.json` and `out/<ASIN>/pages/`.
4. Summarize page count and output paths.
