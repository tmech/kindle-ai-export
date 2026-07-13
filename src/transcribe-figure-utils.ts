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
  maxFiguresPerPage: number
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
  const maxFiguresPerPage = Math.floor(
    thresholds?.maxFiguresPerPage ??
      getNumberEnv('TRANSCRIBE_MAX_FIGURES_PER_PAGE', {
        defaultValue: 3,
        min: 1,
        max: 20
      })
  )
  const margin = Math.max(
    6,
    Math.floor(Math.min(imageWidth, imageHeight) * 0.01)
  )

  const normalizedTextBoxes = textBoxes
    .filter((box) => box.confidence >= textConfidenceThreshold)
    .map(({ bbox }) => normalizeBBox(bbox, imageWidth, imageHeight))
    .filter((bbox) => bboxArea(bbox) > 0)
  const hasAnchoredTextBoxes = normalizedTextBoxes.length > 0
  const candidates: BBox[] = []
  if (!hasAnchoredTextBoxes) {
    const fullPage = makeBBox({
      x0: 0,
      y0: 0,
      x1: imageWidth,
      y1: imageHeight
    })
    if (fullPage) {
      candidates.push(fullPage)
    }
  } else {
    const textBounds = mergeBBoxes(normalizedTextBoxes)
    const textBands = mergeVerticalIntervals(
      normalizedTextBoxes.map((bbox) => ({
        y0: Math.max(0, bbox.y0 - margin),
        y1: Math.min(imageHeight, bbox.y1 + margin)
      }))
    )
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
  }

  const deduped = dedupeBBoxes(candidates, 0.92).toSorted(
    (a, b) => bboxArea(b) - bboxArea(a)
  )

  await fs.mkdir(figuresDir, { recursive: true })
  const scoredCandidates: Array<{
    candidate: BBox
    score: number
    maxStdev: number
  }> = []
  for (const candidate of deduped) {
    const width = candidate.x1 - candidate.x0
    const height = candidate.y1 - candidate.y0
    if (width < minFigureEdge || height < minFigureEdge) continue

    const areaRatio = bboxArea(candidate) / (imageWidth * imageHeight)
    if (areaRatio < minFigureAreaRatio) continue
    const aspectRatio = width / height
    if (aspectRatio > 8 || aspectRatio < 0.125) continue
    if (isLikelyFramingBand(candidate, imageWidth, imageHeight)) continue
    const touchingEdges = countTouchingEdges(candidate, imageWidth, imageHeight)
    const widthRatio = width / imageWidth
    const heightRatio = height / imageHeight
    const edgeAnchoredWideBand =
      widthRatio > 0.9 && (candidate.y0 <= 0 || candidate.y1 >= imageHeight)
    const edgeAnchoredTallBand =
      heightRatio > 0.9 && (candidate.x0 <= 0 || candidate.x1 >= imageWidth)
    if (
      hasAnchoredTextBoxes &&
      touchingEdges >= 2 &&
      (edgeAnchoredWideBand || edgeAnchoredTallBand)
    ) {
      continue
    }
    if (hasAnchoredTextBoxes && touchingEdges >= 2 && areaRatio < 0.25) continue

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
    const score = scoreCandidate({
      candidate,
      imageWidth,
      imageHeight,
      maxStdev,
      touchingEdges
    })

    scoredCandidates.push({
      candidate,
      score,
      maxStdev
    })
  }

  const figures: FigureRegion[] = []
  for (const { candidate } of scoredCandidates
    .toSorted((a, b) => b.score - a.score || b.maxStdev - a.maxStdev)
    .slice(0, maxFiguresPerPage)) {
    const width = candidate.x1 - candidate.x0
    const height = candidate.y1 - candidate.y0
    const adjustedCandidate = insetBBox(
      candidate,
      Math.floor(Math.min(width, height) * 0.04)
    )
    const effective = adjustedCandidate ?? candidate
    const effectiveWidth = effective.x1 - effective.x0
    const effectiveHeight = effective.y1 - effective.y0

    const figure = figures.length + 1
    const figureFileName = `${String(index).padStart(4, '0')}-${String(figure).padStart(2, '0')}.png`
    const absoluteFigurePath = path.join(figuresDir, figureFileName)
    await sharp(screenshotPath)
      .extract({
        left: effective.x0,
        top: effective.y0,
        width: effectiveWidth,
        height: effectiveHeight
      })
      .png()
      .toFile(absoluteFigurePath)

    figures.push({
      index,
      page,
      figure,
      areaRatio: bboxArea(effective) / (imageWidth * imageHeight),
      bbox: effective,
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

function isLikelyFramingBand(
  bbox: BBox,
  imageWidth: number,
  imageHeight: number
): boolean {
  const widthRatio = (bbox.x1 - bbox.x0) / imageWidth
  const heightRatio = (bbox.y1 - bbox.y0) / imageHeight
  if (widthRatio > 0.92 && heightRatio < 0.18) return true
  if (heightRatio > 0.92 && widthRatio < 0.18) return true
  return false
}

function countTouchingEdges(
  bbox: BBox,
  imageWidth: number,
  imageHeight: number
): number {
  let edges = 0
  if (bbox.x0 <= 0) edges++
  if (bbox.y0 <= 0) edges++
  if (bbox.x1 >= imageWidth) edges++
  if (bbox.y1 >= imageHeight) edges++
  return edges
}

function scoreCandidate({
  candidate,
  imageWidth,
  imageHeight,
  maxStdev,
  touchingEdges
}: {
  candidate: BBox
  imageWidth: number
  imageHeight: number
  maxStdev: number
  touchingEdges: number
}): number {
  const area = bboxArea(candidate)
  const areaRatio = area / (imageWidth * imageHeight)
  const centerX = (candidate.x0 + candidate.x1) / 2
  const centerY = (candidate.y0 + candidate.y1) / 2
  const imageCenterX = imageWidth / 2
  const imageCenterY = imageHeight / 2
  const dx = Math.abs(centerX - imageCenterX) / Math.max(1, imageCenterX)
  const dy = Math.abs(centerY - imageCenterY) / Math.max(1, imageCenterY)
  const centeredness = 1 - Math.min(1, Math.hypot(dx, dy))
  const stdevScore = Math.min(1, maxStdev / 64)
  const edgePenalty = touchingEdges * 0.1
  return areaRatio * 0.55 + stdevScore * 0.35 + centeredness * 0.2 - edgePenalty
}

function insetBBox(bbox: BBox, inset: number): BBox | undefined {
  if (inset <= 0) return bbox
  const next: BBox = {
    x0: bbox.x0 + inset,
    y0: bbox.y0 + inset,
    x1: bbox.x1 - inset,
    y1: bbox.y1 - inset
  }
  if (next.x1 <= next.x0 || next.y1 <= next.y0) {
    return
  }
  return next
}
