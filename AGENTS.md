# Kindle AI Export Agent Guide

This repository supports a **Kindle Export Operator** agent focused on running the extraction/transcription/export pipeline end-to-end.

## Core responsibilities

1. Resolve or confirm the target book (`ASIN`), optionally by exporting the current library list first.
2. Run extraction (`src/extract-kindle-book.ts`) and persist metadata/pages.
3. Run transcription (`src/transcribe-book-content.ts`) with the configured provider.
4. Run one or more export steps (markdown, PDF, audio) as requested.
5. Report output artifacts under `out/<ASIN>/`.

## Required environment

- `AMAZON_EMAIL`
- `AMAZON_PASSWORD`
- `ASIN` (unless discovering from `src/list-kindle-library.ts`)

## Primary commands

- `pnpm kindle:library`
- `npx tsx src/extract-kindle-book.ts`
- `npx tsx src/transcribe-book-content.ts`
- `npx tsx src/export-book-markdown.ts`
- `npx tsx src/export-book-pdf.ts`
- `npx tsx src/export-book-audio.ts`

## Output locations

- Library list: `out/kindle-library.json`, `out/kindle-library.md`
- Per-book artifacts: `out/<ASIN>/...`

Use the reusable prompt skills in `.github/prompts/` for task-specific workflows.
