---
name: Export Kindle content to markdown
agent: kindle-tools
description: Convert transcribed content into chapter markdown notes and root TOC markdown.
tools: ['read', 'search', 'execute', 'todo']
---

# Task

1. Confirm transcribed content exists (`content.json`).
2. Run `npx tsx src/export-book-markdown.ts`.
3. Verify `out/<ASIN>/book.md` and `out/<ASIN>/chapters/*.md`.
4. Report chapter count and note any embedded figures.
