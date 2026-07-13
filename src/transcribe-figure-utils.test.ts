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

  it('extracts full-page figure when there are no text boxes and image is non-blank', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ocr-fig-test-'))
    const screenshotPath = path.join(tempDir, 'page.png')
    const figuresDir = path.join(tempDir, 'figures')

    const svg = `<svg width="300" height="300" xmlns="http://www.w3.org/2000/svg">
<rect width="300" height="300" fill="#ffffff"/>
<rect x="25" y="25" width="250" height="250" fill="#4c6ef5"/>
<circle cx="150" cy="150" r="65" fill="#12b886"/>
</svg>`
    await sharp(Buffer.from(svg)).png().toFile(screenshotPath)

    const figures = await detectAndExtractFigureRegions({
      index: 0,
      page: 1,
      screenshotPath,
      textBoxes: [],
      figuresDir,
      thresholds: {
        minFigureAreaRatio: 0.01,
        minFigureEdge: 20,
        minFigureStdev: 0
      }
    })

    expect(figures.length).toBeGreaterThan(0)
    const best = figures[0]!
    expect(best.areaRatio).toBeGreaterThan(0.7)
  })

  it('avoids extracting full-width frame bands when interior art exists', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ocr-fig-test-'))
    const screenshotPath = path.join(tempDir, 'page.png')
    const figuresDir = path.join(tempDir, 'figures')

    const svg = `<svg width="500" height="500" xmlns="http://www.w3.org/2000/svg">
<rect width="500" height="500" fill="#f8f9fa"/>
<rect x="0" y="0" width="500" height="40" fill="#222222"/>
<rect x="0" y="460" width="500" height="40" fill="#222222"/>
<rect x="80" y="120" width="340" height="260" fill="#5c7cfa"/>
<circle cx="250" cy="250" r="90" fill="#15aabf"/>
<line x1="120" y1="340" x2="380" y2="160" stroke="#111111" stroke-width="8"/>
</svg>`
    await sharp(Buffer.from(svg)).png().toFile(screenshotPath)

    const textBoxes: OCRBox[] = [
      { bbox: { x0: 20, y0: 50, x1: 480, y1: 95 }, confidence: 95 },
      { bbox: { x0: 20, y0: 405, x1: 480, y1: 450 }, confidence: 95 }
    ]

    const figures = await detectAndExtractFigureRegions({
      index: 0,
      page: 1,
      screenshotPath,
      textBoxes,
      figuresDir,
      thresholds: {
        minFigureAreaRatio: 0.01,
        minFigureEdge: 20,
        minFigureStdev: 0,
        textConfidenceThreshold: 1
      }
    })

    expect(figures.length).toBeGreaterThan(0)
    const best = figures[0]!
    expect(best.bbox.x0).toBeGreaterThan(10)
    expect(best.bbox.y0).toBeGreaterThan(95)
    expect(best.bbox.y1).toBeLessThan(460)
  })
})
