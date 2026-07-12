import 'dotenv/config'

import fs from 'node:fs/promises'
import path from 'node:path'

import type { BookMetadata, ContentChunk, FigureRegion } from './types'
import {
  buildChapterRanges,
  renderChapterMarkdown,
  renderFrontmatter
} from './markdown-export-utils'
import { assert, getEnv, readJsonFile, tryReadJsonFile } from './utils'

async function main() {
  const asin = getEnv('ASIN')
  assert(asin, 'ASIN is required')

  const outDir = path.join('out', asin)
  const content = await readJsonFile<ContentChunk[]>(
    path.join(outDir, 'content.json')
  )
  const metadata = await readJsonFile<BookMetadata>(
    path.join(outDir, 'metadata.json')
  )
  const figures =
    (await tryReadJsonFile<FigureRegion[]>(
      path.join(outDir, 'figures.json')
    )) ?? []
  assert(content.length, 'no book content found')
  assert(metadata.meta, 'invalid book metadata: missing meta')
  assert(metadata.toc?.length, 'invalid book metadata: missing toc')

  const chapters = buildChapterRanges({ content, toc: metadata.toc })
  const chaptersDir = path.join(outDir, 'chapters')
  await fs.mkdir(chaptersDir, { recursive: true })

  const figuresByIndex = new Map<number, FigureRegion[]>()
  for (const figure of figures) {
    const pageFigures = figuresByIndex.get(figure.index) ?? []
    pageFigures.push(figure)
    figuresByIndex.set(figure.index, pageFigures)
  }

  for (const chapter of chapters) {
    const chapterChunks = content.slice(chapter.startIndex, chapter.endIndex)
    const chapterPageStart =
      chapter.paperPageStart ?? chapterChunks[0]?.page ?? undefined
    const chapterPageEnd =
      chapter.paperPageEnd ?? chapterChunks.at(-1)?.page ?? undefined
    const figureCount = chapterChunks.reduce(
      (count, chunk) => count + (figuresByIndex.get(chunk.index)?.length ?? 0),
      0
    )
    const chapterOutput = renderChapterMarkdown({
      chapter,
      chunks: chapterChunks,
      figuresByIndex,
      outDir,
      chaptersDir,
      frontmatter: {
        note_type: 'kindle-chapter',
        asin: metadata.meta.asin,
        book_title: metadata.meta.title,
        authors: metadata.meta.authorList,
        chapter_title: chapter.title,
        chapter_number: chapter.chapterNumber,
        chapter_depth: chapter.depth,
        chapter_slug: chapter.slug,
        book_markdown_path: '../book.md',
        kindle_toc_position_id: chapter.tocPositionId,
        kindle_position_start: chapter.kindlePositionStart,
        kindle_position_end: chapter.kindlePositionEnd,
        paper_page_start: chapterPageStart,
        paper_page_end: chapterPageEnd,
        content_index_start: chapter.startIndex,
        content_index_end_exclusive: chapter.endIndex,
        figure_count: figureCount
      }
    })
    await fs.writeFile(
      path.join(chaptersDir, `${chapter.slug}.md`),
      chapterOutput
    )
  }

  const toc = chapters
    .map((chapter) => {
      const details = formatChapterTocDetails(chapter)
      const detailSuffix = details ? ` _(${details})_` : ''
      return `${'  '.repeat(chapter.depth)}- [${chapter.title}](./chapters/${chapter.slug}.md)${detailSuffix}`
    })
    .join('\n')

  const output = `${renderFrontmatter({
    note_type: 'kindle-book',
    asin: metadata.meta.asin,
    book_title: metadata.meta.title,
    authors: metadata.meta.authorList,
    chapter_count: chapters.length,
    kindle_position_start: metadata.nav.startPosition,
    kindle_position_end: metadata.nav.endPosition,
    paper_page_start: metadata.nav.startContentPage,
    paper_page_end: metadata.nav.endContentPage,
    chapters_directory: './chapters',
    metadata_json_path: './metadata.json',
    content_json_path: './content.json'
  })}

# ${metadata.meta.title}

> By ${metadata.meta.authorList.join(', ')}

---

## Table of Contents

${toc}

---

_Chapter files are in [./chapters](./chapters)._
`
  await fs.writeFile(path.join(outDir, 'book.md'), output)
  console.log(output)
}

await main()

function formatChapterTocDetails(chapter: {
  paperPageStart?: number
  paperPageEnd?: number
  kindlePositionStart?: number
  kindlePositionEnd?: number
}): string | undefined {
  const parts: string[] = []
  const pageRange = formatRange(chapter.paperPageStart, chapter.paperPageEnd)
  if (pageRange) {
    parts.push(`pp. ${pageRange}`)
  }

  const positionRange = formatRange(
    chapter.kindlePositionStart,
    chapter.kindlePositionEnd
  )
  if (positionRange) {
    parts.push(`pos ${positionRange}`)
  }

  return parts.length ? parts.join('; ') : undefined
}

function formatRange(start?: number, end?: number): string | undefined {
  if (start === undefined && end === undefined) {
    return
  }
  if (start !== undefined && end !== undefined) {
    return start === end ? `${start}` : `${start}-${end}`
  }
  return `${start ?? end}`
}
