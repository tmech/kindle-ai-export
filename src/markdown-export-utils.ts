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
    const text = chunk.text.trim()
    if (text) {
      parts.push(text.replaceAll('\n', '\n\n'))
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

function buildFallbackChapterRanges(
  content: ContentChunk[]
): Array<{
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
