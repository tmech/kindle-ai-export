# Repository instructions for Copilot

- This is a TypeScript Node.js toolchain for exporting Kindle books via Playwright/Patchright + OCR/transcription, with outputs under `out/<ASIN>/`.
- Prefer existing scripts and entry points in `src/` rather than adding new orchestration layers.
- For runtime changes, preserve resumable behavior (existing JSON artifacts should allow safe reruns).
- Keep all filesystem paths relative and Windows-compatible; normalize `\` to `/` only when producing markdown links.
- When adding export/transcription features, update `readme.md` usage steps and output paths.

## Validation

- Unit tests: `pnpm test:unit`
- Typecheck: `pnpm test:typecheck`
- Targeted tests are preferred for localized changes.

## Pipeline entry points

- Library discovery: `src/list-kindle-library.ts`
- Extract pages + metadata: `src/extract-kindle-book.ts`
- Transcribe pages + detect figures: `src/transcribe-book-content.ts`
- Export markdown: `src/export-book-markdown.ts`
- Export PDF: `src/export-book-pdf.ts`
- Export audio: `src/export-book-audio.ts`
