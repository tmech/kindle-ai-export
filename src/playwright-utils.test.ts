import { describe, expect, it } from 'vitest'

import type { TocItem } from './types'
import { parsePageNav, parseTocItems } from './playwright-utils'

describe('parsePageNav', () => {
  it('parses page and location formats', () => {
    expect(parsePageNav('Page 12/548')).toEqual({ page: 12, total: 548 })
    expect(parsePageNav('page 9 of 100')).toEqual({ page: 9, total: 100 })
    expect(parsePageNav('Location 33/9962')).toEqual({
      location: 33,
      total: 9962
    })
    expect(parsePageNav('page iv of 10')).toEqual({
      location: 4,
      total: 10
    })
  })

  it('returns undefined when unparseable', () => {
    expect(parsePageNav('not a nav footer')).toBeUndefined()
    expect(parsePageNav(null)).toBeUndefined()
  })
})

describe('parseTocItems', () => {
  it('returns first content page and first post-content page', () => {
    const tocItems: TocItem[] = [
      { label: 'Cover', positionId: 1, location: 1, depth: 0 },
      { label: 'Chapter 1', positionId: 100, page: 1, depth: 0 },
      { label: 'Chapter 2', positionId: 200, page: 20, depth: 0 },
      { label: 'Acknowledgements', positionId: 300, page: 95, depth: 0 }
    ]

    const parsed = parseTocItems(tocItems, { totalNumPages: 100 })
    expect(parsed.firstContentPageTocItem.label).toBe('Chapter 1')
    expect(parsed.firstPostContentPageTocItem?.label).toBe('Acknowledgements')
  })
})
