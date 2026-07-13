import path from 'node:path'

import type { ContentChunk, FigureRegion, TocItem } from './types'

type FrontmatterValue =
  | string
  | number
  | boolean
  | Array<string | number | boolean>
  | undefined

export type ChapterRange = {
  chapterNumber: number
  title: string
  depth: number
  startIndex: number
  endIndex: number
  slug: string
  kindlePositionStart?: number
  kindlePositionEnd?: number
  paperPageStart?: number
  paperPageEnd?: number
  tocPositionId?: number
}

export function buildChapterRanges({
  content,
  toc
}: {
  content: ContentChunk[]
  toc: TocItem[]
}): ChapterRange[] {
  const anchoredTocEntries = toc
    .filter((tocItem) => tocItem.page !== undefined)
    .map((tocItem) => ({
      tocItem,
      startIndex: content.findIndex((chunk) => chunk.page >= tocItem.page!)
    }))
    .filter((entry) => entry.startIndex >= 0)
  const anchoredTocByStartIndex = new Map<
    number,
    (typeof anchoredTocEntries)[number]
  >()
  for (const entry of anchoredTocEntries) {
    const previous = anchoredTocByStartIndex.get(entry.startIndex)
    if (!previous || previous.tocItem.positionId < entry.tocItem.positionId) {
      anchoredTocByStartIndex.set(entry.startIndex, entry)
    }
  }
  const anchoredToc = Array.from(anchoredTocByStartIndex.values()).toSorted(
    (a, b) => a.startIndex - b.startIndex
  )

  const tocRanges: Array<{
    title: string
    depth: number
    startIndex: number
    endIndex: number
    kindlePositionStart?: number
    kindlePositionEnd?: number
    paperPageStart?: number
    paperPageEnd?: number
    tocPositionId?: number
  }> = []
  let prevIndex = -1
  for (let i = 0; i < anchoredToc.length; i++) {
    const current = anchoredToc[i]!
    const startIndex = current.startIndex
    if (startIndex <= prevIndex) continue
    const next = anchoredToc
      .slice(i + 1)
      .find((candidate) => candidate.startIndex > startIndex)
    const endIndex = next?.startIndex ?? content.length
    if (endIndex <= startIndex) continue

    const nextAnchor = anchoredToc
      .slice(i + 1)
      .find((candidate) => candidate.startIndex > startIndex)
    const nextTocItem = nextAnchor?.tocItem
    const kindlePositionStart = current.tocItem.positionId
    const kindlePositionEnd =
      nextTocItem && nextTocItem.positionId > kindlePositionStart
        ? nextTocItem.positionId - 1
        : undefined
    const paperPageStart = current.tocItem.page
    const paperPageEnd =
      nextTocItem?.page !== undefined && nextTocItem.page > paperPageStart
        ? nextTocItem.page - 1
        : undefined

    tocRanges.push({
      title: current.tocItem.label,
      depth: Math.max(0, current.tocItem.depth),
      startIndex,
      endIndex,
      kindlePositionStart,
      kindlePositionEnd,
      paperPageStart,
      paperPageEnd,
      tocPositionId: current.tocItem.positionId
    })
    prevIndex = startIndex
  }

  if (tocRanges.length >= 2) {
    return withUniqueSlugs(tocRanges)
  }

  return withUniqueSlugs(buildFallbackChapterRanges(content))
}

export function renderChapterMarkdown({
  chapter,
  chunks,
  figuresByIndex,
  outDir,
  chaptersDir,
  frontmatter
}: {
  chapter: ChapterRange
  chunks: ContentChunk[]
  figuresByIndex: Map<number, FigureRegion[]>
  outDir: string
  chaptersDir: string
  frontmatter?: Record<string, FrontmatterValue>
}): string {
  const parts = [`# ${chapter.title}`]
  for (const chunk of chunks) {
    const blocks = renderChunkTextToMarkdownBlocks({
      text: chunk.text,
      paragraphStartLineIndices: chunk.paragraphStartLineIndices
    })
    if (blocks.length) {
      appendChunkBlocks(parts, blocks)
    }

    const figures = (figuresByIndex.get(chunk.index) ?? []).toSorted(
      (a, b) => a.figure - b.figure
    )
    for (const figure of figures) {
      const imagePath = resolveFigurePath({
        figure,
        outDir,
        chaptersDir
      })
      if (!imagePath) continue
      const alt = figure.captionHint ?? `Figure ${figure.page}.${figure.figure}`
      parts.push(`![${alt}](${imagePath})`)
    }
  }

  const body = `${parts.join('\n\n')}\n`
  if (!frontmatter) {
    return body
  }

  return `${renderFrontmatter(frontmatter)}\n${body}`
}

function appendChunkBlocks(parts: string[], blocks: string[]): void {
  if (!blocks.length) return
  const normalizedBlocks = blocks.map((block) =>
    isNonParagraphMarkdownBlock(block)
      ? block
      : normalizeOcrFirstPersonPronoun(block)
  )
  const firstBlock = normalizedBlocks[0]!
  const last = parts.at(-1)
  if (last && shouldMergeAdjacentParagraphBlocks(last, firstBlock)) {
    parts[parts.length - 1] = normalizeOcrFirstPersonPronoun(
      `${last.trimEnd()} ${firstBlock.trimStart()}`
    )
  } else {
    parts.push(firstBlock)
  }

  for (let i = 1; i < normalizedBlocks.length; i++) {
    parts.push(normalizedBlocks[i]!)
  }
}

export function renderFrontmatter(
  frontmatter: Record<string, FrontmatterValue>
): string {
  const lines = ['---']

  for (const [key, value] of Object.entries(frontmatter)) {
    if (value === undefined) {
      continue
    }

    if (Array.isArray(value)) {
      if (!value.length) {
        lines.push(`${key}: []`)
        continue
      }

      lines.push(`${key}:`)
      for (const item of value) {
        lines.push(`  - ${formatYamlScalar(item)}`)
      }
      continue
    }

    lines.push(`${key}: ${formatYamlScalar(value)}`)
  }

  lines.push('---')
  return lines.join('\n')
}

function buildFallbackChapterRanges(content: ContentChunk[]): Array<{
  title: string
  depth: number
  startIndex: number
  endIndex: number
}> {
  const boundaries: number[] = [0]
  const maxPagesPerChapter = 30
  let chapterStartPage = content[0]?.page ?? 1

  for (let i = 1; i < content.length; i++) {
    const prevChunk = content[i - 1]!
    const chunk = content[i]!
    if (chunk.page === prevChunk.page) continue

    const pageSpan = chunk.page - chapterStartPage
    const heading = extractHeading(chunk.text)
    if (heading || pageSpan >= maxPagesPerChapter) {
      boundaries.push(i)
      chapterStartPage = chunk.page
    }
  }

  if (boundaries.length === 1) {
    return [
      {
        title: 'Chapter 1',
        depth: 0,
        startIndex: 0,
        endIndex: content.length
      }
    ]
  }

  const ranges: Array<{
    title: string
    depth: number
    startIndex: number
    endIndex: number
  }> = []
  for (let i = 0; i < boundaries.length; i++) {
    const startIndex = boundaries[i]!
    const endIndex = boundaries[i + 1] ?? content.length
    const heading = extractHeading(content[startIndex]!.text)
    ranges.push({
      title: heading || `Chapter ${i + 1}`,
      depth: 0,
      startIndex,
      endIndex
    })
  }

  return ranges
}

function extractHeading(text: string): string | undefined {
  const line = text.split('\n')[0]?.replaceAll(/\s+/g, ' ').trim()
  if (!line) return
  if (line.length > 120) return
  if (!/^(chapter|prologue|epilogue|part)\b/i.test(line)) return
  return line
}

function withUniqueSlugs(
  chapters: Array<{
    title: string
    depth: number
    startIndex: number
    endIndex: number
    kindlePositionStart?: number
    kindlePositionEnd?: number
    paperPageStart?: number
    paperPageEnd?: number
    tocPositionId?: number
  }>
): ChapterRange[] {
  const slugCounts = new Map<string, number>()
  return chapters.map((chapter, index) => {
    const baseSlug = slugify(chapter.title) || `chapter-${index + 1}`
    const count = (slugCounts.get(baseSlug) ?? 0) + 1
    slugCounts.set(baseSlug, count)
    const slug = count > 1 ? `${baseSlug}-${count}` : baseSlug
    return {
      ...chapter,
      chapterNumber: index + 1,
      slug
    }
  })
}

function resolveFigurePath({
  figure,
  outDir,
  chaptersDir
}: {
  figure: FigureRegion
  outDir: string
  chaptersDir: string
}): string | undefined {
  if (!figure.imagePath?.trim()) {
    return
  }

  const absoluteImagePath = path.isAbsolute(figure.imagePath)
    ? figure.imagePath
    : path.resolve(outDir, figure.imagePath)
  return path.relative(chaptersDir, absoluteImagePath).replaceAll('\\', '/')
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
}

function formatYamlScalar(value: string | number | boolean): string {
  if (typeof value === 'string') {
    return JSON.stringify(value)
  }

  return `${value}`
}

type MarkdownBlock =
  | { kind: 'paragraph'; text: string }
  | { kind: 'heading'; text: string }
  | { kind: 'list'; items: string[] }
  | { kind: 'ordered-list'; items: string[] }
  | { kind: 'blockquote'; lines: string[] }

function renderChunkTextToMarkdownBlocks({
  text,
  paragraphStartLineIndices
}: {
  text: string
  paragraphStartLineIndices?: number[]
}): string[] {
  const rawLines = text
    .split('\n')
    .map((line) => line.replaceAll(/\s+/g, ' ').trim())
    .map((line) => normalizeOcrFirstPersonPronoun(line))
  const lineTokens = applyParagraphBreakHints(
    rawLines,
    paragraphStartLineIndices
  )
  const blocks: MarkdownBlock[] = []
  let paragraphLines: string[] = []
  let listItems: string[] = []

  const flushParagraph = () => {
    if (!paragraphLines.length) return
    const paragraph = joinWrappedLines(paragraphLines)
    paragraphLines = []
    if (paragraph) {
      blocks.push(...splitParagraphIntoMarkdownBlocks(paragraph))
    }
  }

  const flushList = () => {
    if (!listItems.length) return
    blocks.push({ kind: 'list', items: listItems })
    listItems = []
  }

  for (let i = 0; i < lineTokens.length; i++) {
    const token = lineTokens[i]!
    const line = token.line
    if (!line) {
      if (token.forcedBreak) {
        flushParagraph()
        flushList()
        continue
      }
      const prevLine = paragraphLines.at(-1)
      const nextLine = findNextNonEmptyLine(lineTokens, i + 1)
      if (
        prevLine &&
        nextLine &&
        shouldIgnoreBlankParagraphBreak(prevLine, nextLine)
      ) {
        continue
      }
      flushParagraph()
      flushList()
      continue
    }

    const listItem = parseListItem(line)
    if (listItem) {
      flushParagraph()
      listItems.push(listItem)
      continue
    }

    const attribution = parseQuoteAttribution(line)
    if (attribution) {
      flushParagraph()
      flushList()

      const lastBlock = blocks.at(-1)
      if (!lastBlock || lastBlock.kind === 'heading') {
        blocks.push({ kind: 'paragraph', text: `— ${attribution}` })
        continue
      }

      if (lastBlock.kind === 'blockquote') {
        lastBlock.lines.push(`— ${attribution}`)
        continue
      }

      if (lastBlock.kind === 'paragraph') {
        blocks[blocks.length - 1] = {
          kind: 'blockquote',
          lines: [lastBlock.text, `— ${attribution}`]
        }
        continue
      }

      if (lastBlock.kind === 'list') {
        blocks.push({ kind: 'paragraph', text: `— ${attribution}` })
      }
      continue
    }

    if (isAllCapsHeading(line)) {
      flushParagraph()
      flushList()
      blocks.push({ kind: 'heading', text: line })
      continue
    }

    flushList()
    if (
      paragraphLines.length &&
      shouldStartNewParagraph(paragraphLines.at(-1)!, line)
    ) {
      flushParagraph()
    }
    paragraphLines.push(line)
  }

  flushParagraph()
  flushList()

  return blocks.map(renderMarkdownBlock)
}

function renderMarkdownBlock(block: MarkdownBlock): string {
  switch (block.kind) {
    case 'heading':
      return `## ${block.text}`
    case 'list':
      return block.items.map((item) => `- ${item}`).join('\n')
    case 'ordered-list':
      return block.items
        .map((item, index) => `${index + 1}. ${item}`)
        .join('\n')
    case 'blockquote':
      return block.lines.map((line) => `> ${line}`).join('\n')
    case 'paragraph':
      return block.text
  }
}

function parseListItem(line: string): string | undefined {
  const match = line.match(/^«\+?\s*(.+)$/)
  if (!match?.[1]) {
    return
  }
  return match[1].trim()
}

function parseQuoteAttribution(line: string): string | undefined {
  const match = line.match(/^--\s*(.+)$/)
  if (!match?.[1]) {
    return
  }
  return match[1].trim()
}

function joinWrappedLines(lines: string[]): string {
  if (!lines.length) return ''
  let output = lines[0]!
  for (let i = 1; i < lines.length; i++) {
    const prev = output
    const line = lines[i]!
    if (prev.endsWith('-') && /^[a-z]/.test(line)) {
      output = `${prev.slice(0, -1)}${line}`
      continue
    }

    output = `${output} ${line}`
  }

  return output.trim()
}

function shouldStartNewParagraph(prevLine: string, line: string): boolean {
  if (!endsWithTerminalPunctuation(prevLine)) {
    return false
  }

  if (/^[“"‘'—-]/.test(line)) {
    return true
  }

  return false
}

function endsWithTerminalPunctuation(line: string): boolean {
  return /[.!?]["'”’)]?$/.test(line)
}

function isAllCapsHeading(line: string): boolean {
  if (line.length < 3 || line.length > 80) return false
  if (line.startsWith('#')) return false

  const letters = line.match(/[A-Za-z]/g)
  if (!letters || letters.length < 4) return false
  const hasLowercase = /[a-z]/.test(line)
  if (hasLowercase) return false

  const words = line.split(/\s+/).filter(Boolean)
  if (words.length >= 2) return true

  return /^(chapter|prologue|epilogue|part|book|section)\b/i.test(line)
}

function shouldMergeAdjacentParagraphBlocks(
  prev: string,
  next: string
): boolean {
  if (!prev.trim() || !next.trim()) return false
  if (isNonParagraphMarkdownBlock(prev) || isNonParagraphMarkdownBlock(next)) {
    return false
  }
  if (prev.includes('\n\n') || next.includes('\n\n')) {
    return false
  }

  const prevTail = prev.trimEnd().split('\n').at(-1) ?? ''
  const nextHead = next.trimStart().split('\n')[0] ?? ''
  if (!prevTail || !nextHead) return false

  if (!endsWithTerminalPunctuation(prevTail)) {
    return true
  }
  if (/\b(and|or|but|nor|so|yet)$/i.test(prevTail)) {
    return true
  }
  const nextHeadFirstChar = nextHead[0]?.toLowerCase()
  if (
    nextHeadFirstChar &&
    'abcdefghijklmnopqrstuvwxyz0123456789(['.includes(nextHeadFirstChar)
  ) {
    return true
  }

  return false
}

function isNonParagraphMarkdownBlock(block: string): boolean {
  const trimmed = block.trimStart()
  return (
    trimmed.startsWith('#') ||
    trimmed.startsWith('>') ||
    trimmed.startsWith('- ') ||
    /^\d+\.\s/.test(trimmed) ||
    trimmed.startsWith('![')
  )
}

function shouldIgnoreBlankParagraphBreak(
  prevLine: string,
  nextLine: string
): boolean {
  if (!prevLine || !nextLine) return false
  if (!endsWithTerminalPunctuation(prevLine)) return true
  if (/[,;:—-]$/.test(prevLine)) return true
  if (/\b(and|or|but|nor|so|yet)$/i.test(prevLine)) return true
  const nextLineFirstChar = nextLine[0]?.toLowerCase()
  if (
    nextLineFirstChar &&
    'abcdefghijklmnopqrstuvwxyz0123456789(['.includes(nextLineFirstChar)
  )
    return true
  return false
}

function findNextNonEmptyLine(
  lines: Array<{ line: string; forcedBreak: boolean }>,
  startIndex: number
): string | undefined {
  for (const { line } of lines.slice(startIndex)) {
    if (line) {
      return line
    }
  }

  return undefined
}

function applyParagraphBreakHints(
  lines: string[],
  paragraphStartLineIndices?: number[]
): Array<{ line: string; forcedBreak: boolean }> {
  if (!paragraphStartLineIndices?.length) {
    return lines.map((line) => ({ line, forcedBreak: false }))
  }

  const hintSet = new Set(
    paragraphStartLineIndices.filter(
      (index) =>
        Number.isInteger(index) &&
        index > 0 &&
        index < Math.max(1, lines.length)
    )
  )
  const result: Array<{ line: string; forcedBreak: boolean }> = []
  for (const [i, line] of lines.entries()) {
    if (hintSet.has(i)) {
      result.push({ line: '', forcedBreak: true })
    }
    result.push({ line, forcedBreak: false })
  }

  return result
}

function normalizeOcrFirstPersonPronoun(line: string): string {
  if (!line || isLikelyMarkdownTableLine(line)) {
    return line
  }

  return line
    .replaceAll(
      /(^|[\s([{"“‘'`])\|(?=(?:\s+[A-Za-z]|['’](?:m|d|ll|ve|re|s)\b))/g,
      '$1I'
    )
    .replaceAll(/(^|\s)\|(?=\s+[a-z])/g, '$1I')
}

function isLikelyMarkdownTableLine(line: string): boolean {
  const trimmed = line.trim()
  if (!trimmed.includes('|')) return false
  if (/^\|.*\|$/.test(trimmed)) return true
  if (/^:?-{3,}:?(?:\s*\|\s*:?-{3,}:?)+$/.test(trimmed)) return true
  const pipeCount = Array.from(trimmed).filter((char) => char === '|').length
  if (
    pipeCount >= 2 &&
    !/[.!?]/.test(trimmed) &&
    /^[^|]*\|[^|]*\|[^|]*$/.test(trimmed)
  ) {
    return true
  }

  return false
}

function splitParagraphIntoMarkdownBlocks(paragraph: string): MarkdownBlock[] {
  const normalized = paragraph
    .replaceAll(/([.!?])\s+([A-Z][A-Za-z'’\s,-]{3,80}:\s+1\.\s+)/g, '$1\n$2')
    .replaceAll(/([:.!?])\s+(\d{1,2})\.\s+(?=[A-Z(“"'])/g, '$1\n$2. ')
  const lines = normalized
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  if (!lines.length) {
    return []
  }

  const blocks: MarkdownBlock[] = []
  let paragraphParts: string[] = []
  let orderedItems: string[] = []

  const flushParagraphParts = () => {
    if (!paragraphParts.length) return
    blocks.push({ kind: 'paragraph', text: paragraphParts.join(' ').trim() })
    paragraphParts = []
  }
  const flushOrderedItems = () => {
    if (!orderedItems.length) return
    blocks.push({ kind: 'ordered-list', items: orderedItems })
    orderedItems = []
  }

  for (const line of lines) {
    const orderedItem = parseOrderedListItem(line)
    if (orderedItem) {
      flushParagraphParts()
      orderedItems.push(orderedItem)
      continue
    }

    flushOrderedItems()
    paragraphParts.push(line)
  }

  flushOrderedItems()
  flushParagraphParts()
  return blocks
}

function parseOrderedListItem(line: string): string | undefined {
  const match = line.match(/^(\d{1,2})\.\s+(.+)$/)
  if (!match?.[2]) {
    return
  }

  return match[2].trim()
}
