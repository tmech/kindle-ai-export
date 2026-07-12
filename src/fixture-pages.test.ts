import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import type { ContentChunk, TocItem } from './types'
import { buildChapterRanges } from './markdown-export-utils'

const fixturePagesDir = path.join('out', 'B00C1NKPUE', 'pages')

describe('real fixture pages', () => {
  it('covers the requested page profiles when fixtures exist', () => {
    if (!fs.existsSync(fixturePagesDir)) {
      return
    }

    const expectedPages = ['071-045.png', '001-002.png', '067-043.png']
    const optionalChapterStart = ['001-001.png', '000-001.png']
    for (const page of expectedPages) {
      expect(fs.existsSync(path.join(fixturePagesDir, page))).toBe(true)
    }
    expect(
      optionalChapterStart.some((page) =>
        fs.existsSync(path.join(fixturePagesDir, page))
      )
    ).toBe(true)
  })
})

describe('markdown conversion from realistic page progression', () => {
  it('creates chapter ranges from TOC anchors', () => {
    const content: ContentChunk[] = [
      {
        index: 0,
        page: 1,
        text: 'Chapter 1\n\nStart',
        screenshot: '000-001.png'
      },
      { index: 1, page: 2, text: 'Text-only page', screenshot: '001-002.png' },
      {
        index: 2,
        page: 43,
        text: 'Image-only-ish page marker',
        screenshot: '067-043.png'
      },
      {
        index: 3,
        page: 45,
        text: 'Text and diagram marker',
        screenshot: '071-045.png'
      }
    ]
    const toc: TocItem[] = [
      { label: 'Chapter 1', positionId: 10, page: 1, depth: 0 },
      { label: 'Chapter 2', positionId: 20, page: 45, depth: 0 }
    ]
    const chapters = buildChapterRanges({ content, toc })

    expect(chapters).toHaveLength(2)
    expect(chapters[0]!.startIndex).toBe(0)
    expect(chapters[0]!.endIndex).toBe(3)
    expect(chapters[1]!.startIndex).toBe(3)
  })
})
