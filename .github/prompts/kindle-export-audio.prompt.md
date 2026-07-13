---
name: Export Kindle content to audiobook
agent: kindle-tools
description: Generate AI narration audio chunks and merged audiobook from chapter/content output.
tools: ['read', 'search', 'execute', 'todo']
---

# Task

1. Confirm TTS env vars are set for selected engine (`openai` or `unrealspeech`).
2. Run `npx tsx src/export-book-audio.ts`.
3. Verify `out/<ASIN>/audio/<tts-engine-hash>/audiobook.mp3`.
4. Return output path and engine used.
