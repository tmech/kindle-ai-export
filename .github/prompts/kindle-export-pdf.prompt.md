---
name: Export Kindle content to PDF
agent: kindle-tools
description: Generate a PDF from transcribed/extracted content.
tools: ['read', 'search', 'execute', 'todo']
---

# Task

1. Confirm required book outputs exist for the target ASIN.
2. Run `npx tsx src/export-book-pdf.ts`.
3. Verify `out/<ASIN>/book.pdf`.
4. Return the output path.
