import { describe, expect, it } from 'vitest'

import type { ContentChunk, FigureRegion, TocItem } from './types'
import {
  buildChapterRanges,
  type ChapterRange,
  renderChapterMarkdown,
  renderFrontmatter
} from './markdown-export-utils'

describe('buildChapterRanges', () => {
  it('uses TOC boundaries and de-dupes slugs', () => {
    const content: ContentChunk[] = [
      { index: 0, page: 1, text: 'A', screenshot: 'p0.png' },
      { index: 1, page: 2, text: 'B', screenshot: 'p1.png' },
      { index: 2, page: 3, text: 'C', screenshot: 'p2.png' }
    ]
    const toc: TocItem[] = [
      { label: 'Chapter 1', positionId: 1, page: 1, depth: 0 },
      { label: 'Chapter 1', positionId: 2, page: 2, depth: 0 },
      { label: 'Chapter 3', positionId: 3, page: 3, depth: 0 }
    ]

    const chapters = buildChapterRanges({ content, toc })
    expect(chapters).toHaveLength(3)
    expect(chapters.map((c) => c.slug)).toEqual([
      'chapter-1',
      'chapter-1-2',
      'chapter-3'
    ])
    expect(chapters.map((c) => c.chapterNumber)).toEqual([1, 2, 3])
    expect(chapters[0]!.kindlePositionStart).toBe(1)
    expect(chapters[0]!.kindlePositionEnd).toBe(1)
    expect(chapters[0]!.paperPageStart).toBe(1)
    expect(chapters[0]!.paperPageEnd).toBe(1)
    expect(chapters[2]!.kindlePositionEnd).toBeUndefined()
  })

  it('prefers latest toc anchor when multiple items map to same page/index', () => {
    const content: ContentChunk[] = [
      { index: 0, page: 1, text: 'One', screenshot: 'p0.png' },
      { index: 1, page: 2, text: 'Two', screenshot: 'p1.png' }
    ]
    const toc: TocItem[] = [
      { label: 'Cover', positionId: 1, page: 1, depth: 0 },
      { label: 'Chapter 1', positionId: 50, page: 1, depth: 0 },
      { label: 'Chapter 2', positionId: 100, page: 2, depth: 0 }
    ]

    const chapters = buildChapterRanges({ content, toc })
    expect(chapters[0]!.title).toBe('Chapter 1')
    expect(chapters[0]!.kindlePositionStart).toBe(50)
  })

  it('falls back when TOC anchors are missing', () => {
    const content: ContentChunk[] = [
      { index: 0, page: 1, text: 'Intro', screenshot: '0.png' },
      {
        index: 1,
        page: 2,
        text: 'Chapter 2\n\nSome text',
        screenshot: '1.png'
      },
      { index: 2, page: 3, text: 'More text', screenshot: '2.png' }
    ]
    const toc: TocItem[] = [
      { label: 'Cover', positionId: 1, location: 1, depth: 0 }
    ]
    const chapters = buildChapterRanges({ content, toc })

    expect(chapters.length).toBeGreaterThanOrEqual(1)
    expect(chapters[0]!.title).toMatch(/chapter|intro/i)
  })
})

describe('renderChapterMarkdown', () => {
  it('renders text and embedded figures', () => {
    const chapter: ChapterRange = {
      chapterNumber: 1,
      title: 'Chapter 1',
      depth: 0,
      startIndex: 0,
      endIndex: 1,
      slug: 'chapter-1',
      kindlePositionStart: 100,
      paperPageStart: 1
    }
    const chunks: ContentChunk[] = [
      {
        index: 0,
        page: 1,
        text: 'Hello\nWorld',
        screenshot: 'out\\B\\pages\\0.png'
      }
    ]
    const figures: FigureRegion[] = [
      {
        index: 0,
        page: 1,
        figure: 1,
        areaRatio: 0.3,
        bbox: { x0: 0, y0: 0, x1: 50, y1: 50 },
        screenshot: 'out\\B\\pages\\0.png',
        imagePath: 'figures\\0000-01.png'
      }
    ]
    const figuresByIndex = new Map<number, FigureRegion[]>([[0, figures]])

    const markdown = renderChapterMarkdown({
      chapter,
      chunks,
      figuresByIndex,
      outDir: 'out\\B',
      chaptersDir: 'out\\B\\chapters',
      frontmatter: {
        note_type: 'kindle-chapter',
        chapter_number: 1,
        chapter_title: chapter.title,
        authors: ['Unknown Author']
      }
    })

    expect(markdown).toContain('---\n')
    expect(markdown).toContain('note_type: "kindle-chapter"')
    expect(markdown).toContain('chapter_number: 1')
    expect(markdown).toContain('# Chapter 1')
    expect(markdown).toContain('Hello World')
    expect(markdown).toContain('![Figure 1.1](../figures/0000-01.png)')
  })

  it('applies line-based markdown conventions', () => {
    const chapter: ChapterRange = {
      chapterNumber: 1,
      title: 'Chapter 1',
      depth: 0,
      startIndex: 0,
      endIndex: 1,
      slug: 'chapter-1'
    }
    const chunks: ContentChunk[] = [
      {
        index: 0,
        page: 1,
        text: [
          'PROLOGUE',
          'This is a wrapped',
          'paragraph across lines.',
          '',
          '« first bullet',
          '«+ second bullet',
          '',
          '“Quoted line.”',
          '-- Ada Lovelace'
        ].join('\n'),
        screenshot: 'out\\B\\pages\\0.png'
      }
    ]

    const markdown = renderChapterMarkdown({
      chapter,
      chunks,
      figuresByIndex: new Map(),
      outDir: 'out\\B',
      chaptersDir: 'out\\B\\chapters'
    })

    expect(markdown).toContain('## PROLOGUE')
    expect(markdown).toContain('This is a wrapped paragraph across lines.')
    expect(markdown).toContain('- first bullet\n- second bullet')
    expect(markdown).toContain('> “Quoted line.”\n> — Ada Lovelace')
  })

  it('keeps wrapped text together across accidental blank lines', () => {
    const chapter: ChapterRange = {
      chapterNumber: 1,
      title: 'Chapter 1',
      depth: 0,
      startIndex: 0,
      endIndex: 1,
      slug: 'chapter-1'
    }
    const chunks: ContentChunk[] = [
      {
        index: 0,
        page: 1,
        text: ['This sentence ends with and', '', 'then continues here.'].join(
          '\n'
        ),
        screenshot: 'out\\B\\pages\\0.png'
      }
    ]

    const markdown = renderChapterMarkdown({
      chapter,
      chunks,
      figuresByIndex: new Map(),
      outDir: 'out\\B',
      chaptersDir: 'out\\B\\chapters'
    })

    expect(markdown).toContain(
      'This sentence ends with and then continues here.'
    )
  })

  it('merges split paragraphs across chunk boundaries', () => {
    const chapter: ChapterRange = {
      chapterNumber: 1,
      title: 'Chapter 1',
      depth: 0,
      startIndex: 0,
      endIndex: 2,
      slug: 'chapter-1'
    }
    const chunks: ContentChunk[] = [
      {
        index: 0,
        page: 1,
        text: 'We saw many stocks hit the 52-week-high list and',
        screenshot: 'out\\B\\pages\\0.png'
      },
      {
        index: 1,
        page: 1,
        text: 'then skyrocket even higher in price.',
        screenshot: 'out\\B\\pages\\1.png'
      }
    ]

    const markdown = renderChapterMarkdown({
      chapter,
      chunks,
      figuresByIndex: new Map(),
      outDir: 'out\\B',
      chaptersDir: 'out\\B\\chapters'
    })

    expect(markdown).toContain(
      'We saw many stocks hit the 52-week-high list and then skyrocket even higher in price.'
    )
  })

  it('extracts inline numbered list sequences into markdown ordered lists', () => {
    const chapter: ChapterRange = {
      chapterNumber: 1,
      title: 'Chapter 1',
      depth: 0,
      startIndex: 0,
      endIndex: 1,
      slug: 'chapter-1'
    }
    const chunks: ContentChunk[] = [
      {
        index: 0,
        page: 1,
        text: [
          'The basic characteristics are: 1. Trend. First item.',
          '2. Fundamentals. Second item. 3. Catalyst. Third item.'
        ].join(' '),
        screenshot: 'out\\B\\pages\\0.png'
      }
    ]

    const markdown = renderChapterMarkdown({
      chapter,
      chunks,
      figuresByIndex: new Map(),
      outDir: 'out\\B',
      chaptersDir: 'out\\B\\chapters'
    })

    expect(markdown).toContain('The basic characteristics are:')
    expect(markdown).toContain(
      '1. Trend. First item.\n2. Fundamentals. Second item.\n3. Catalyst. Third item.'
    )
  })

  it('fixes common OCR | pronoun errors conservatively', () => {
    const chapter: ChapterRange = {
      chapterNumber: 1,
      title: 'Chapter 1',
      depth: 0,
      startIndex: 0,
      endIndex: 1,
      slug: 'chapter-1'
    }
    const chunks: ContentChunk[] = [
      {
        index: 0,
        page: 1,
        text: [
          '| began to learn.',
          "Then |'ve improved.",
          '',
          '| col1 | col2 |'
        ].join('\n'),
        screenshot: 'out\\B\\pages\\0.png'
      }
    ]

    const markdown = renderChapterMarkdown({
      chapter,
      chunks,
      figuresByIndex: new Map(),
      outDir: 'out\\B',
      chaptersDir: 'out\\B\\chapters'
    })

    expect(markdown).toContain("I began to learn. Then I've improved.")
    expect(markdown).toContain('| col1 | col2 |')
  })

  it('fixes OCR | pronoun when token spans chunk boundaries', () => {
    const chapter: ChapterRange = {
      chapterNumber: 1,
      title: 'Chapter 1',
      depth: 0,
      startIndex: 0,
      endIndex: 2,
      slug: 'chapter-1'
    }
    const chunks: ContentChunk[] = [
      {
        index: 0,
        page: 1,
        text: 'every book |',
        screenshot: 'out\\B\\pages\\0.png'
      },
      {
        index: 1,
        page: 1,
        text: 'could get my hands on',
        screenshot: 'out\\B\\pages\\1.png'
      }
    ]

    const markdown = renderChapterMarkdown({
      chapter,
      chunks,
      figuresByIndex: new Map(),
      outDir: 'out\\B',
      chaptersDir: 'out\\B\\chapters'
    })

    expect(markdown).toContain('every book I could get my hands on')
  })

  it('honors paragraph boundary hints captured during transcription', () => {
    const chapter: ChapterRange = {
      chapterNumber: 1,
      title: 'Chapter 1',
      depth: 0,
      startIndex: 0,
      endIndex: 1,
      slug: 'chapter-1'
    }
    const chunks: ContentChunk[] = [
      {
        index: 0,
        page: 1,
        text: ['this should end first para', 'next para starts here'].join(
          '\n'
        ),
        paragraphStartLineIndices: [1],
        screenshot: 'out\\B\\pages\\0.png'
      }
    ]

    const markdown = renderChapterMarkdown({
      chapter,
      chunks,
      figuresByIndex: new Map(),
      outDir: 'out\\B',
      chaptersDir: 'out\\B\\chapters'
    })

    expect(markdown).toContain(
      'this should end first para\n\nnext para starts here'
    )
  })
})

describe('renderFrontmatter', () => {
  it('renders yaml frontmatter with arrays and scalars', () => {
    const frontmatter = renderFrontmatter({
      note_type: 'kindle-book',
      asin: 'B00TEST',
      chapter_count: 2,
      authors: ['Unknown Author', 'Jane Doe']
    })

    expect(frontmatter).toContain('---')
    expect(frontmatter).toContain('note_type: "kindle-book"')
    expect(frontmatter).toContain('chapter_count: 2')
    expect(frontmatter).toContain(
      'authors:\n  - "Unknown Author"\n  - "Jane Doe"'
    )
  })
})
