---
name: Transcribe Kindle pages to content
agent: kindle-tools
description: Transcribe extracted page images to content.json and figures.json with resumable behavior.
tools: ['read', 'search', 'execute', 'todo']
---

# Task

1. Ensure extraction outputs exist for the target `ASIN`.
2. Run `npx tsx src/transcribe-book-content.ts`.
3. Confirm `out/<ASIN>/content.json` and `out/<ASIN>/figures.json` were written.
4. Report completion/failed pages and any figure detection summary from logs.
