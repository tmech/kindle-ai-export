import fs from 'node:fs/promises'
import path from 'node:path'

import sharp from 'sharp'

import type { FigureRegion, OCRBox } from './types'
import { getEnv } from './utils'

type BBox = {
  x0: number
  y0: number
  x1: number
  y1: number
}

type FigureThresholds = Partial<{
  minFigureAreaRatio: number
  minFigureEdge: number
  minFigureStdev: number
  textConfidenceThreshold: number
}>

export async function detectAndExtractFigureRegions({
  index,
  page,
  screenshotPath,
  textBoxes,
  figuresDir,
  thresholds
}: {
  index: number
  page: number
  screenshotPath: string
  textBoxes: OCRBox[]
  figuresDir: string
  thresholds?: FigureThresholds
}): Promise<FigureRegion[]> {
  const metadata = await sharp(screenshotPath).metadata()
  const imageWidth = metadata.width ?? 0
  const imageHeight = metadata.height ?? 0
  if (imageWidth <= 0 || imageHeight <= 0) {
    return []
  }

  const minFigureAreaRatio =
    thresholds?.minFigureAreaRatio ??
    getNumberEnv('TRANSCRIBE_MIN_FIGURE_AREA_RATIO', {
      defaultValue: 0.015,
      min: 0.001,
      max: 0.9
    })
  const minFigureEdge = Math.floor(
    thresholds?.minFigureEdge ??
      getNumberEnv('TRANSCRIBE_MIN_FIGURE_EDGE', {
        defaultValue: 80,
        min: 24,
        max: Math.max(imageWidth, imageHeight)
      })
  )
  const minFigureStdev =
    thresholds?.minFigureStdev ??
    getNumberEnv('TRANSCRIBE_MIN_FIGURE_STDEV', {
      defaultValue: 6,
      min: 0,
      max: 255
    })
  const textConfidenceThreshold =
    thresholds?.textConfidenceThreshold ??
    getNumberEnv('TRANSCRIBE_MIN_TEXT_BOX_CONFIDENCE', {
      defaultValue: 15,
      min: 0,
      max: 100
    })
  const margin = Math.max(
    6,
    Math.floor(Math.min(imageWidth, imageHeight) * 0.01)
  )

  const normalizedTextBoxes = textBoxes
    .filter((box) => box.confidence >= textConfidenceThreshold)
    .map(({ bbox }) => normalizeBBox(bbox, imageWidth, imageHeight))
    .filter((bbox) => bboxArea(bbox) > 0)
  if (!normalizedTextBoxes.length) {
    return []
  }

  const textBounds = mergeBBoxes(normalizedTextBoxes)
  const textBands = mergeVerticalIntervals(
    normalizedTextBoxes.map((bbox) => ({
      y0: Math.max(0, bbox.y0 - margin),
      y1: Math.min(imageHeight, bbox.y1 + margin)
    }))
  )

  const candidates: BBox[] = []
  const top = makeBBox({
    x0: 0,
    y0: 0,
    x1: imageWidth,
    y1: textBounds.y0 - margin
  })
  if (top) candidates.push(top)

  const bottom = makeBBox({
    x0: 0,
    y0: textBounds.y1 + margin,
    x1: imageWidth,
    y1: imageHeight
  })
  if (bottom) candidates.push(bottom)

  const left = makeBBox({
    x0: 0,
    y0: textBounds.y0,
    x1: textBounds.x0 - margin,
    y1: textBounds.y1
  })
  if (left) candidates.push(left)

  const right = makeBBox({
    x0: textBounds.x1 + margin,
    y0: textBounds.y0,
    x1: imageWidth,
    y1: textBounds.y1
  })
  if (right) candidates.push(right)

  for (let i = 0; i < textBands.length - 1; i++) {
    const band = textBands[i]!
    const nextBand = textBands[i + 1]!
    const gap = makeBBox({
      x0: 0,
      y0: band.y1,
      x1: imageWidth,
      y1: nextBand.y0
    })
    if (gap) {
      candidates.push(gap)
    }
  }

  const deduped = dedupeBBoxes(candidates, 0.92).toSorted(
    (a, b) => bboxArea(b) - bboxArea(a)
  )

  await fs.mkdir(figuresDir, { recursive: true })
  const figures: FigureRegion[] = []
  for (const candidate of deduped) {
    const width = candidate.x1 - candidate.x0
    const height = candidate.y1 - candidate.y0
    if (width < minFigureEdge || height < minFigureEdge) continue

    const areaRatio = bboxArea(candidate) / (imageWidth * imageHeight)
    if (areaRatio < minFigureAreaRatio) continue
    const aspectRatio = width / height
    if (aspectRatio > 8 || aspectRatio < 0.125) continue

    const stats = await sharp(screenshotPath)
      .extract({
        left: candidate.x0,
        top: candidate.y0,
        width,
        height
      })
      .stats()
    const maxStdev = Math.max(...stats.channels.map((c) => c.stdev))
    if (maxStdev < minFigureStdev) continue

    const figure = figures.length + 1
    const figureFileName = `${String(index).padStart(4, '0')}-${String(figure).padStart(2, '0')}.png`
    const absoluteFigurePath = path.join(figuresDir, figureFileName)
    await sharp(screenshotPath)
      .extract({
        left: candidate.x0,
        top: candidate.y0,
        width,
        height
      })
      .png()
      .toFile(absoluteFigurePath)

    figures.push({
      index,
      page,
      figure,
      areaRatio,
      bbox: candidate,
      screenshot: screenshotPath,
      imagePath: path.join('figures', figureFileName)
    })
  }

  return figures
}

function getNumberEnv(
  name: string,
  {
    defaultValue,
    min,
    max
  }: {
    defaultValue: number
    min: number
    max: number
  }
): number {
  const value = getEnv(name)
  if (!value?.trim()) {
    return defaultValue
  }

  const parsed = Number.parseFloat(value)
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid ${name}: ${value}`)
  }

  return Math.max(min, Math.min(max, parsed))
}

function normalizeBBox(bbox: BBox, width: number, height: number): BBox {
  const x0 = clamp(Math.floor(Math.min(bbox.x0, bbox.x1)), 0, width)
  const y0 = clamp(Math.floor(Math.min(bbox.y0, bbox.y1)), 0, height)
  const x1 = clamp(Math.ceil(Math.max(bbox.x0, bbox.x1)), 0, width)
  const y1 = clamp(Math.ceil(Math.max(bbox.y0, bbox.y1)), 0, height)
  return { x0, y0, x1, y1 }
}

function mergeBBoxes(boxes: BBox[]): BBox {
  let x0 = Number.POSITIVE_INFINITY
  let y0 = Number.POSITIVE_INFINITY
  let x1 = Number.NEGATIVE_INFINITY
  let y1 = Number.NEGATIVE_INFINITY

  for (const box of boxes) {
    x0 = Math.min(x0, box.x0)
    y0 = Math.min(y0, box.y0)
    x1 = Math.max(x1, box.x1)
    y1 = Math.max(y1, box.y1)
  }

  return {
    x0: Math.max(0, x0),
    y0: Math.max(0, y0),
    x1: Math.max(0, x1),
    y1: Math.max(0, y1)
  }
}

function mergeVerticalIntervals(
  intervals: Array<{ y0: number; y1: number }>
): Array<{ y0: number; y1: number }> {
  if (intervals.length === 0) {
    return []
  }

  const sorted = intervals.toSorted((a, b) => a.y0 - b.y0)
  const merged = [sorted[0]!]
  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i]!
    const last = merged.at(-1)!
    if (current.y0 <= last.y1) {
      last.y1 = Math.max(last.y1, current.y1)
    } else {
      merged.push({ ...current })
    }
  }

  return merged
}

function dedupeBBoxes(boxes: BBox[], overlapThreshold: number): BBox[] {
  const accepted: BBox[] = []
  for (const box of boxes) {
    const overlapsExisting = accepted.some((other) => {
      const overlapArea = intersectionArea(box, other)
      if (overlapArea <= 0) return false
      const smallerArea = Math.min(bboxArea(box), bboxArea(other))
      return overlapArea / smallerArea >= overlapThreshold
    })
    if (!overlapsExisting) {
      accepted.push(box)
    }
  }

  return accepted
}

function intersectionArea(a: BBox, b: BBox): number {
  const x0 = Math.max(a.x0, b.x0)
  const y0 = Math.max(a.y0, b.y0)
  const x1 = Math.min(a.x1, b.x1)
  const y1 = Math.min(a.y1, b.y1)
  if (x1 <= x0 || y1 <= y0) return 0
  return (x1 - x0) * (y1 - y0)
}

function bboxArea(bbox: BBox): number {
  const width = Math.max(0, bbox.x1 - bbox.x0)
  const height = Math.max(0, bbox.y1 - bbox.y0)
  return width * height
}

function makeBBox(bbox: BBox): BBox | undefined {
  const normalized = normalizeBBox(
    bbox,
    Math.max(bbox.x0, bbox.x1),
    Math.max(bbox.y0, bbox.y1)
  )
  if (normalized.x1 <= normalized.x0 || normalized.y1 <= normalized.y0) {
    return
  }

  return normalized
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}
