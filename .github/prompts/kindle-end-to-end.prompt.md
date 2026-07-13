---
name: Kindle end-to-end pipeline
agent: kindle-tools
description: Run Kindle workflow from library lookup/ASIN selection through extract, transcribe, and selected exports.
tools: ['read', 'search', 'execute', 'todo']
---

# Task

1. If ASIN is not provided, run the library search skill first.
2. Run extraction: `npx tsx src/extract-kindle-book.ts`.
3. Run transcription: `npx tsx src/transcribe-book-content.ts`.
4. Run requested exports (markdown/pdf/audio).
5. Return all produced artifact paths under `out/<ASIN>/`.
