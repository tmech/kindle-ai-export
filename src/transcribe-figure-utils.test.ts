import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import sharp from 'sharp'
import { describe, expect, it } from 'vitest'

import type { OCRBox } from './types'
import { detectAndExtractFigureRegions } from './transcribe-figure-utils'

describe('detectAndExtractFigureRegions', () => {
  it('extracts figure regions between text bands', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ocr-fig-test-'))
    const screenshotPath = path.join(tempDir, 'page.png')
    const figuresDir = path.join(tempDir, 'figures')

    const svg = `<svg width="400" height="400" xmlns="http://www.w3.org/2000/svg">
<rect width="400" height="400" fill="#ffffff"/>
<rect x="40" y="130" width="320" height="140" fill="#4c6ef5"/>
<circle cx="200" cy="200" r="45" fill="#22b8cf"/>
<line x1="60" y1="150" x2="340" y2="250" stroke="#111111" stroke-width="6"/>
</svg>`
    await sharp(Buffer.from(svg)).png().toFile(screenshotPath)

    const textBoxes: OCRBox[] = [
      { bbox: { x0: 30, y0: 20, x1: 370, y1: 90 }, confidence: 90 },
      { bbox: { x0: 30, y0: 300, x1: 370, y1: 380 }, confidence: 90 }
    ]

    const figures = await detectAndExtractFigureRegions({
      index: 0,
      page: 1,
      screenshotPath,
      textBoxes,
      figuresDir,
      thresholds: {
        minFigureAreaRatio: 0.005,
        minFigureEdge: 20,
        minFigureStdev: 0,
        textConfidenceThreshold: 1
      }
    })

    expect(figures.length).toBeGreaterThan(0)
    expect(figures[0]!.imagePath).toMatch(/^figures[\\/]/)
    const files = await fs.readdir(figuresDir)
    expect(files.length).toBeGreaterThan(0)
  })

  it('returns no figures when there are no text boxes', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ocr-fig-test-'))
    const screenshotPath = path.join(tempDir, 'page.png')
    await sharp({
      create: {
        width: 200,
        height: 200,
        channels: 3,
        background: '#ffffff'
      }
    })
      .png()
      .toFile(screenshotPath)

    const figures = await detectAndExtractFigureRegions({
      index: 0,
      page: 1,
      screenshotPath,
      textBoxes: [],
      figuresDir: path.join(tempDir, 'figures')
    })

    expect(figures).toEqual([])
  })
})
