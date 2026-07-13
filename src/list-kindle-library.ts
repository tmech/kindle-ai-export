import 'dotenv/config'

import fs from 'node:fs/promises'
import path from 'node:path'

import { input } from '@inquirer/prompts'
import delay from 'delay'
import { chromium } from 'patchright'

import { assert, getEnv } from './utils'

type KindleLibraryBook = {
  asin: string
  title: string
  author?: string
  href?: string
  thumbnail?: string
}

async function main() {
  const amazonEmail = getEnv('AMAZON_EMAIL')
  const amazonPassword = getEnv('AMAZON_PASSWORD')
  assert(amazonEmail, 'AMAZON_EMAIL is required')
  assert(amazonPassword, 'AMAZON_PASSWORD is required')

  const args = parseArgs(process.argv.slice(2))
  const outDir = path.join('out')
  const userDataDir = path.join(outDir, 'kindle-library-data')
  const outputPath = path.join(outDir, 'kindle-library.json')
  const outputMarkdownPath = path.join(outDir, 'kindle-library.md')
  await fs.mkdir(userDataDir, { recursive: true })
  await fs.mkdir(outDir, { recursive: true })

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    channel: 'chrome',
    args: [
      '--hide-crash-restore-bubble',
      '--disable-features=PasswordAutosave',
      '--disable-features=WebAuthn',
      '--disable-features=MacAppCodeSignClone'
    ],
    ignoreDefaultArgs: [
      '--enable-automation',
      '--no-sandbox',
      '--disable-blink-features=AutomationControlled'
    ],
    bypassCSP: true,
    viewport: { width: 1440, height: 900 }
  })

  try {
    const page = context.pages()[0] ?? (await context.newPage())
    const libraryUrl = 'https://read.amazon.com/kindle-library'

    await Promise.any([
      page.goto(libraryUrl, { timeout: 30_000 }),
      page.waitForURL('**/ap/signin', { timeout: 30_000 })
    ])

    if (/\/ap\/signin/g.test(new URL(page.url()).pathname)) {
      await page.locator('input[type="email"]').fill(amazonEmail)
      await page.locator('input[type="submit"]').click()

      await page.locator('input[type="password"]').fill(amazonPassword)
      await page.locator('input[type="submit"]').click()

      if (!/\/kindle-library/g.test(new URL(page.url()).pathname)) {
        const code = await input({ message: '2-factor auth code?' })
        if (code) {
          await page.locator('input[type="tel"]').fill(code)
          await page
            .locator(
              'input[type="submit"][aria-labelledby="cvf-submit-otp-button-announce"]'
            )
            .click()
        }
      }
    }

    await page.goto(libraryUrl, { waitUntil: 'domcontentloaded' })
    await page.waitForTimeout(1000)

    const booksByAsin = new Map<string, KindleLibraryBook>()
    let previousTotal = 0
    let unchangedIterations = 0

    while (unchangedIterations < 6) {
      const books = await scrapeLibraryBooks(page)
      for (const book of books) {
        const existing = booksByAsin.get(book.asin)
        if (!existing) {
          booksByAsin.set(book.asin, book)
        } else {
          booksByAsin.set(book.asin, {
            ...existing,
            ...book,
            title:
              existing.title.length >= book.title.length
                ? existing.title
                : book.title
          })
        }
      }

      const currentTotal = booksByAsin.size
      if (currentTotal === previousTotal) {
        unchangedIterations++
      } else {
        previousTotal = currentTotal
        unchangedIterations = 0
      }

      await page.evaluate(() => {
        const g = globalThis as any
        g.window.scrollTo(0, g.document.body.scrollHeight)
      })
      await delay(1200)
    }

    const allBooks = Array.from(booksByAsin.values()).toSorted((a, b) =>
      a.title.localeCompare(b.title, undefined, { sensitivity: 'base' })
    )

    const filteredBooks = args.query
      ? allBooks.filter((book) => {
          const haystack =
            `${book.title} ${book.author ?? ''} ${book.asin}`.toLowerCase()
          return haystack.includes(args.query!.toLowerCase())
        })
      : allBooks
    const selectedBooks =
      args.limit !== undefined
        ? filteredBooks.slice(0, args.limit)
        : filteredBooks

    const payload = {
      generatedAt: new Date().toISOString(),
      total: allBooks.length,
      filteredTotal: filteredBooks.length,
      query: args.query,
      books: selectedBooks
    }

    await fs.writeFile(outputPath, JSON.stringify(payload, null, 2))
    await fs.writeFile(
      outputMarkdownPath,
      renderLibraryMarkdown({
        generatedAt: payload.generatedAt,
        total: payload.total,
        filteredTotal: payload.filteredTotal,
        query: payload.query,
        books: payload.books
      })
    )

    console.log(
      `Exported ${payload.books.length}/${payload.filteredTotal} books (${payload.total} total) to ${outputPath}`
    )
    console.log(`Markdown list written to ${outputMarkdownPath}`)
  } finally {
    await context.close()
  }
}

await main()

function parseArgs(argv: string[]): { query?: string; limit?: number } {
  let query: string | undefined
  let limit: number | undefined
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if ((arg === '--query' || arg === '-q') && argv[i + 1]) {
      query = argv[i + 1]!
      i++
      continue
    }
    if ((arg === '--limit' || arg === '-n') && argv[i + 1]) {
      const parsed = Number.parseInt(argv[i + 1]!, 10)
      if (Number.isFinite(parsed) && parsed > 0) {
        limit = parsed
      }
      i++
    }
  }

  return { query, limit }
}

async function scrapeLibraryBooks(page: {
  evaluate: <T>(pageFunction: () => T) => Promise<T>
}): Promise<KindleLibraryBook[]> {
  return page.evaluate(() => {
    const g = globalThis as any
    const doc = g.document as any
    const win = g.window as any
    const booksByAsin = new Map<string, KindleLibraryBook>()
    const anchors = Array.from<any>(doc.querySelectorAll('a[href]'))

    // Must be defined in page context for evaluate.
    // eslint-disable-next-line unicorn/consistent-function-scoping
    const parseAsin = (href: string): string | undefined => {
      const queryMatch = href.match(/[?&]asin=([A-Z0-9]{10})/i)?.[1]
      if (queryMatch) return queryMatch.toUpperCase()

      const pathMatch = href.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i)?.[1]
      if (pathMatch) return pathMatch.toUpperCase()

      return undefined
    }

    for (const anchor of anchors) {
      const href = anchor.getAttribute('href') ?? ''
      const asin = parseAsin(href)
      if (!asin) continue

      const container = anchor.closest('li, article, [role="listitem"], div')
      const titleCandidates = [
        anchor.getAttribute('aria-label'),
        anchor.getAttribute('title'),
        anchor.textContent,
        container?.querySelector('[title]')?.getAttribute('title'),
        container?.querySelector('h2, h3, h4')?.textContent,
        container?.querySelector('img[alt]')?.getAttribute('alt')
      ]
      const title = titleCandidates
        .map((value) => value?.replaceAll(/\s+/g, ' ').trim())
        .find((value) => value && value.length > 1)
      if (!title) continue

      const containerText = container?.textContent
        ?.replaceAll(/\s+/g, ' ')
        .trim()
      const authorMatch = containerText?.match(/\bby\s+([^|•]+)$/i)
      const author = authorMatch?.[1]?.trim()
      const thumbnail =
        container?.querySelector('img')?.getAttribute('src') ?? undefined
      const absoluteHref = new URL(href, win.location.origin).toString()
      const existing = booksByAsin.get(asin)
      if (!existing || existing.title.length < title.length) {
        booksByAsin.set(asin, {
          asin,
          title,
          author,
          thumbnail,
          href: absoluteHref
        })
      }
    }

    return Array.from(booksByAsin.values())
  })
}

function renderLibraryMarkdown({
  generatedAt,
  total,
  filteredTotal,
  query,
  books
}: {
  generatedAt: string
  total: number
  filteredTotal: number
  query?: string
  books: KindleLibraryBook[]
}): string {
  const heading = query
    ? `# Kindle Library Results for "${query}"`
    : '# Kindle Library'
  const lines = [
    heading,
    '',
    `Generated: ${generatedAt}`,
    `Books shown: ${books.length} (filtered: ${filteredTotal}, total: ${total})`,
    ''
  ]

  for (const [index, book] of books.entries()) {
    const authorSuffix = book.author ? ` — ${book.author}` : ''
    lines.push(
      `${index + 1}. **${book.title}**${authorSuffix} _(ASIN: ${book.asin})_`
    )
  }

  return `${lines.join('\n')}\n`
}
