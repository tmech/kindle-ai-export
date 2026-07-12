import 'dotenv/config'

import { createWriteStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { inspect } from 'node:util'

import { FoundryLocalManager, type IModel } from 'foundry-local-sdk'
import { OpenAIClient } from 'openai-fetch'
import pMap from 'p-map'
import { createWorker, OEM } from 'tesseract.js'

import type {
  BookMetadata,
  ContentChunk,
  FigureRegion,
  OCRBox,
  TocItem
} from './types'
import { detectAndExtractFigureRegions } from './transcribe-figure-utils'
import { assert, getEnv, readJsonFile, tryReadJsonFile } from './utils'

type TranscribeProvider = 'openai' | 'foundrylocal' | 'tesseract'

type TranscriptionClient = {
  transcribePage: (args: {
    screenshotPath: string
    imageDataUrl: string
    temperature: number
  }) => Promise<{
    text: string
    textBoxes?: OCRBox[]
  }>
  cleanup?: () => Promise<void>
}

async function main() {
  const asin = getEnv('ASIN')
  assert(asin, 'ASIN is required')

  const outDir = path.join('out', asin)
  await fs.mkdir(outDir, { recursive: true })
  const restoreConsole = await teeConsoleToFile(
    path.join(outDir, 'transcribe.log')
  )
  try {
    const metadata = await readJsonFile<BookMetadata>(
      path.join(outDir, 'metadata.json')
    )
    const contentPath = path.join(outDir, 'content.json')
    assert(metadata.pages?.length, 'no page screenshots found')
    assert(metadata.toc?.length, 'invalid book metadata: missing toc')

    const pageToTocItemMap = metadata.toc.reduce(
      (acc, tocItem) => {
        if (tocItem.page !== undefined) {
          acc[tocItem.page] = tocItem
        }
        return acc
      },
      {} as Record<number, TocItem>
    )

    const rawTranscribeProvider = (
      getEnv('TRANSCRIBE_PROVIDER') ?? 'foundrylocal'
    ).toLowerCase()
    assert(
      rawTranscribeProvider === 'openai' ||
        rawTranscribeProvider === 'foundrylocal' ||
        rawTranscribeProvider === 'tesseract',
      `Invalid transcription provider "${rawTranscribeProvider}"`
    )
    const transcribeProvider = rawTranscribeProvider as TranscribeProvider
    const transcribeModel = resolveTranscribeModel({
      transcribeProvider,
      requestedModel: getEnv('TRANSCRIBE_MODEL')
    })
    assert(transcribeModel, 'TRANSCRIBE_MODEL is required')
    const maxRetries = Number.parseInt(
      getEnv('TRANSCRIBE_MAX_RETRIES') ?? '20',
      10
    )
    assert(
      Number.isFinite(maxRetries) && maxRetries > 0,
      `Invalid TRANSCRIBE_MAX_RETRIES: ${maxRetries}`
    )
    const defaultConcurrency = transcribeProvider === 'foundrylocal' ? 2 : 16
    const concurrency = Number.parseInt(
      getEnv('TRANSCRIBE_CONCURRENCY') ?? `${defaultConcurrency}`,
      10
    )
    assert(
      Number.isFinite(concurrency) && concurrency > 0,
      `Invalid TRANSCRIBE_CONCURRENCY: ${concurrency}`
    )

    const transcriptionClient = await createTranscriptionClient({
      transcribeProvider,
      transcribeModel
    })

    const existingContent =
      (await tryReadJsonFile<ContentChunk[]>(contentPath)) ?? []
    assert(
      Array.isArray(existingContent),
      `Invalid content file: ${contentPath}`
    )
    const contentByIndex = new Map<number, ContentChunk>()
    for (const chunk of existingContent) {
      contentByIndex.set(chunk.index, chunk)
    }
    const figuresPath = path.join(outDir, 'figures.json')
    const figuresDir = path.join(outDir, 'figures')
    const detectFigures = getEnv('TRANSCRIBE_DETECT_FIGURES') !== 'false'
    const existingFigures =
      (await tryReadJsonFile<FigureRegion[]>(figuresPath)) ?? []
    assert(
      Array.isArray(existingFigures),
      `Invalid figures file: ${figuresPath}`
    )
    const figuresByIndex = new Map<number, FigureRegion[]>()
    for (const figure of existingFigures) {
      const pageFigures = figuresByIndex.get(figure.index) ?? []
      pageFigures.push(figure)
      figuresByIndex.set(figure.index, pageFigures)
    }

    const pagesToTranscribe = metadata.pages.filter(
      (pageChunk) => !contentByIndex.has(pageChunk.index)
    )

    if (pagesToTranscribe.length < metadata.pages.length) {
      console.log(
        `Resuming transcription: ${contentByIndex.size}/${metadata.pages.length} pages already in ${contentPath}`
      )
    }

    console.log(
      `Using transcription provider "${transcribeProvider}" with model "${transcribeModel}" and concurrency ${concurrency}`
    )

    const totalPages = metadata.pages.length
    let completedPages = contentByIndex.size
    let failedPages = 0
    const transcriptionStartedAt = Date.now()
    let persistQueue = Promise.resolve<void>(undefined)

    try {
      await pMap(
        pagesToTranscribe,
        async (pageChunk) => {
          const { screenshot, index, page } = pageChunk
          const pageStartedAt = Date.now()
          const screenshotBuffer = await fs.readFile(screenshot)
          const screenshotBase64 = `data:image/png;base64,${screenshotBuffer.toString('base64')}`

          try {
            let retries = 0

            console.log(
              `Transcribing page ${page} (${completedPages}/${totalPages} complete, ${totalPages - completedPages} remaining)...`
            )

            do {
              const transcription = await transcriptionClient.transcribePage({
                screenshotPath: screenshot,
                imageDataUrl: screenshotBase64,
                temperature: retries < 2 ? 0 : 0.5
              })

              const rawText = transcription.text
              let text = rawText
                .replace(/^\s*\d+\s*$\n+/m, '')
                .replaceAll(/^\s*/gm, '')
                .replaceAll(/\s*$/gm, '')

              ++retries

              if (!text) {
                if (retries >= maxRetries) {
                  throw new Error(
                    `Model returned no text too many times (${retries} times)`
                  )
                }
                continue
              }
              if (text.length < 100 && /i'm sorry/i.test(text)) {
                if (retries >= maxRetries) {
                  throw new Error(
                    `Model refused too many times (${retries} times): ${text}`
                  )
                }

                console.warn('retrying refusal...', {
                  index,
                  text,
                  screenshot
                })
                continue
              }

              const prevPageChunk = metadata.pages[index - 1]
              if (prevPageChunk && prevPageChunk.page !== page) {
                const tocItem = pageToTocItemMap[page]
                if (tocItem) {
                  text = text.replace(
                    // eslint-disable-next-line security/detect-non-literal-regexp
                    new RegExp(`^${tocItem.label}\\s*`, 'i'),
                    ''
                  )
                }
              }

              const result: ContentChunk = {
                index,
                page,
                text,
                screenshot
              }

              const figureRegions =
                detectFigures && transcription.textBoxes?.length
                  ? await detectAndExtractFigureRegions({
                      index,
                      page,
                      screenshotPath: screenshot,
                      textBoxes: transcription.textBoxes,
                      figuresDir
                    })
                  : []

              const persistResult = persistQueue.then(async () => {
                contentByIndex.set(index, result)
                if (figureRegions.length) {
                  figuresByIndex.set(index, figureRegions)
                } else {
                  figuresByIndex.delete(index)
                }
                await fs.writeFile(
                  contentPath,
                  JSON.stringify(
                    Array.from(contentByIndex.values()).toSorted(
                      (a, b) => a.index - b.index
                    ),
                    null,
                    2
                  )
                )
                await fs.writeFile(
                  figuresPath,
                  JSON.stringify(
                    Array.from(figuresByIndex.values())
                      .flat()
                      .toSorted(
                        (a, b) =>
                          a.index - b.index ||
                          a.figure - b.figure ||
                          a.page - b.page
                      ),
                    null,
                    2
                  )
                )
              })
              persistQueue = persistResult.catch(() => undefined)
              await persistResult

              ++completedPages
              console.log(
                `Transcribed page ${page} in ${formatDurationMs(
                  Date.now() - pageStartedAt
                )} (${completedPages}/${totalPages} complete, ${
                  totalPages - completedPages
                } remaining)`
              )
              if (figureRegions.length) {
                console.log(
                  `Detected ${figureRegions.length} figure region(s) on page ${page}`
                )
              }
              console.log(result)

              return
            } while (true)
          } catch (err) {
            ++failedPages
            console.error(
              `error processing image ${index} (${screenshot}) after ${formatDurationMs(
                Date.now() - pageStartedAt
              )} (${completedPages}/${totalPages} complete, ${totalPages - completedPages} remaining)`,
              err
            )
          }
        },
        { concurrency }
      )

      await persistQueue
      const content = Array.from(contentByIndex.values()).toSorted(
        (a, b) => a.index - b.index
      )
      await fs.writeFile(contentPath, JSON.stringify(content, null, 2))
      await fs.writeFile(
        figuresPath,
        JSON.stringify(
          Array.from(figuresByIndex.values())
            .flat()
            .toSorted(
              (a, b) =>
                a.index - b.index || a.figure - b.figure || a.page - b.page
            ),
          null,
          2
        )
      )
      console.log(
        `Transcription finished: ${completedPages}/${totalPages} pages complete, ${failedPages} failed, total ${formatDurationMs(
          Date.now() - transcriptionStartedAt
        )}, avg ${formatDurationMs(
          completedPages > 0
            ? Math.floor((Date.now() - transcriptionStartedAt) / completedPages)
            : 0
        )}/page`
      )
      console.log(JSON.stringify(content, null, 2))
    } finally {
      if (transcriptionClient.cleanup) {
        await transcriptionClient.cleanup()
      }
    }
  } finally {
    restoreConsole()
  }
}

await main()

function resolveTranscribeModel({
  transcribeProvider,
  requestedModel
}: {
  transcribeProvider: TranscribeProvider
  requestedModel: string | undefined
}): string {
  const normalizedRequestedModel = requestedModel?.trim()
  if (transcribeProvider === 'openai') {
    return normalizedRequestedModel || 'gpt-4.1-mini'
  }

  if (!normalizedRequestedModel) {
    return 'qwen3-vl-2b-instruct'
  }

  if (normalizedRequestedModel.toLowerCase() === 'phi-3.5-vision-instruct') {
    console.warn(
      'TRANSCRIBE_MODEL=Phi-3.5-vision-instruct is no longer available in Foundry. Falling back to qwen3-vl-2b-instruct.'
    )
    return 'qwen3-vl-2b-instruct'
  }

  return normalizedRequestedModel
}

async function createTranscriptionClient({
  transcribeProvider,
  transcribeModel
}: {
  transcribeProvider: TranscribeProvider
  transcribeModel: string
}): Promise<TranscriptionClient> {
  if (transcribeProvider === 'tesseract') {
    const langs = (getEnv('TRANSCRIBE_TESSERACT_LANG') ?? 'eng')
      .split(',')
      .map((lang) => lang.trim())
      .filter(Boolean)
    assert(langs.length > 0, 'TRANSCRIBE_TESSERACT_LANG must not be empty')
    const worker = await createWorker(
      langs.length === 1 ? langs[0]! : langs,
      OEM.LSTM_ONLY,
      {
        logger: (message) => {
          if (message.progress >= 1) return
          if (message.status === 'recognizing text') return
          console.log(
            `[tesseract] ${message.status} ${Math.floor(message.progress * 100)}%`
          )
        }
      }
    )

    return {
      transcribePage: async ({ screenshotPath }) => {
        const result = await worker.recognize(
          screenshotPath,
          {},
          { text: true, blocks: true }
        )
        const textBoxes: OCRBox[] =
          result.data.blocks?.map((block) => ({
            bbox: block.bbox,
            confidence: block.confidence
          })) ?? []
        return {
          text: result.data.text ?? '',
          textBoxes
        }
      },
      cleanup: async () => {
        await worker.terminate()
      }
    }
  }

  if (transcribeProvider === 'openai') {
    const openai = new OpenAIClient()

    return {
      transcribePage: async ({ imageDataUrl, temperature }) => {
        const response = await openai.createChatCompletion({
          model: transcribeModel,
          temperature,
          messages: [
            {
              role: 'system',
              content: `You will be given an image containing text. Read the text from the image and output it verbatim.

Do not include any additional text, descriptions, or punctuation. Ignore any embedded images. Do not use markdown.${temperature > 0 ? '\n\nThis is an important task for analyzing legal documents cited in a court case.' : ''}`
            },
            {
              role: 'user',
              content: [
                {
                  type: 'image_url',
                  image_url: {
                    url: imageDataUrl
                  }
                }
              ] as any
            }
          ]
        })
        return {
          text: response.choices[0]!.message.content!
        }
      }
    }
  }

  console.log(
    `Preparing Foundry model "${transcribeModel}" for transcription...`
  )
  const modelLoadStartedAt = Date.now()
  const { manager, model } = await getFoundryLocalModel(transcribeModel)
  console.log(
    `Foundry model "${model.id}" ready in ${formatDurationMs(Date.now() - modelLoadStartedAt)}`
  )
  manager.startWebService()
  const webServiceUrl = manager.urls[0]
  assert(
    webServiceUrl,
    'Foundry web service did not expose a URL after startWebService().'
  )
  const baseUrl = webServiceUrl.endsWith('/v1')
    ? webServiceUrl
    : `${webServiceUrl.replace(/\/$/, '')}/v1`
  const openai = new OpenAIClient({
    apiKey: getEnv('FOUNDRY_LOCAL_API_KEY')?.trim() || 'local',
    baseUrl
  })
  console.log(`Using Foundry web service endpoint: ${baseUrl}`)

  return {
    transcribePage: async ({ imageDataUrl, temperature }) => {
      const response = await openai.createChatCompletion({
        model: transcribeModel,
        temperature,
        messages: [
          {
            role: 'system',
            content: `You will be given an image containing text. Read the text from the image and output it verbatim.

Do not include any additional text, descriptions, or punctuation. Ignore any embedded images. Do not use markdown.${temperature > 0 ? '\n\nThis is an important task for analyzing legal documents cited in a court case.' : ''}`
          },
          {
            role: 'user',
            content: [
              {
                type: 'image_url',
                image_url: {
                  url: imageDataUrl
                }
              }
            ] as any
          }
        ]
      })
      return {
        text: response.choices[0]!.message.content!
      }
    },
    cleanup: async () => {
      await model.unload()
      if (manager.isWebServiceRunning) {
        manager.stopWebService()
      }
    }
  }
}

async function getFoundryLocalModel(
  modelAlias: string
): Promise<{ manager: FoundryLocalManager; model: IModel }> {
  let manager: FoundryLocalManager
  try {
    manager = FoundryLocalManager.create({
      appName: getEnv('FOUNDRY_LOCAL_APP_NAME') ?? 'kindle-ai-export',
      logLevel:
        (getEnv('FOUNDRY_LOCAL_LOG_LEVEL') as
          | 'trace'
          | 'debug'
          | 'info'
          | 'warn'
          | 'error'
          | 'fatal') ?? 'warn'
    })
  } catch (err) {
    const message = `${err}`
    if (/foundrylocalcorepath|auto-discover binaries/i.test(message)) {
      throw new Error(
        `Foundry Local SDK native binaries were not found.\nRun "pnpm approve-builds" and allow foundry-local-sdk, then run "pnpm rebuild foundry-local-sdk".`,
        { cause: err as Error }
      )
    }

    throw err
  }

  await ensureFoundryExecutionProviders(manager)

  let model: IModel
  try {
    model = await manager.catalog.getModel(modelAlias)
  } catch (err) {
    const models = await manager.catalog.getModels()
    const aliases = models.map((m) => m.alias).toSorted()
    throw new Error(
      `Foundry model alias "${modelAlias}" was not found in the local catalog.\nAvailable aliases: ${aliases.join(', ')}`,
      { cause: err as Error }
    )
  }

  const modelVariant = getEnv('FOUNDRY_LOCAL_MODEL_VARIANT')?.trim()
  if (modelVariant) {
    const selectedVariant = await manager.catalog.getModelVariant(modelVariant)
    assert(
      selectedVariant.alias === model.alias,
      `FOUNDRY_LOCAL_MODEL_VARIANT "${modelVariant}" does not match model alias "${model.alias}"`
    )
    model.selectVariant(selectedVariant)
  } else {
    const gpuVariant = model.variants.find(
      (variant) =>
        `${variant.info.runtime?.deviceType ?? ''}`.toLowerCase() === 'gpu'
    )
    if (gpuVariant) {
      model.selectVariant(gpuVariant)
      console.log(`Selected GPU model variant "${gpuVariant.id}"`)
    } else {
      console.warn(
        `No GPU variant found for "${model.alias}". Using default variant "${model.id}".`
      )
    }
  }

  if (!model.isCached) {
    console.log(`Downloading Foundry model "${model.alias}"...`)
    await model.download((progress) => {
      process.stdout.write(
        `\rDownloading model "${model.alias}": ${progress.toFixed(2)}%`
      )
    })
    process.stdout.write('\n')
  }

  const loadStartedAt = Date.now()
  console.log(`Loading Foundry model "${model.id}"...`)
  try {
    await model.load()
  } catch (err) {
    const message = `${err}`
    if (
      /spatial_merge_size|image_token_id|vision_start_token_id/i.test(message)
    ) {
      throw new Error(
        `Foundry runtime/model-pack mismatch while loading "${model.id}". The local runtime rejected vision config fields.\nUpdate Foundry Local runtime to match the installed model pack version and retry.`,
        { cause: err as Error }
      )
    }

    throw err
  }
  console.log(
    `Loaded Foundry model "${model.id}" in ${formatDurationMs(Date.now() - loadStartedAt)}`
  )

  return {
    manager,
    model
  }
}

async function ensureFoundryExecutionProviders(
  manager: FoundryLocalManager
): Promise<void> {
  const eps = manager.discoverEps()
  const missingEpNames = eps
    .filter((ep) => !ep.isRegistered)
    .map((ep) => ep.name)
  if (missingEpNames.length === 0) {
    return
  }

  console.log(
    `Registering execution providers: ${missingEpNames.join(', ')}...`
  )
  const result = await manager.downloadAndRegisterEps(missingEpNames)
  if (!result.success) {
    console.warn(
      `Execution provider registration incomplete: ${result.status}. Registered: ${result.registeredEps.join(', ') || '(none)'}; Failed: ${result.failedEps.join(', ') || '(none)'}`
    )
    return
  }

  console.log(`Execution providers ready: ${result.registeredEps.join(', ')}`)
}

function formatDurationMs(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes <= 0) {
    return `${seconds}s`
  }

  return `${minutes}m ${seconds}s`
}

async function teeConsoleToFile(logFilePath: string): Promise<() => void> {
  await fs.mkdir(path.dirname(logFilePath), { recursive: true })
  const stream = createWriteStream(logFilePath, {
    flags: 'a',
    encoding: 'utf8'
  })

  const originalLog = console.log
  const originalWarn = console.warn
  const originalError = console.error

  const write = (level: 'INFO' | 'WARN' | 'ERROR', args: unknown[]) => {
    const line = `[${new Date().toISOString()}] [${level}] ${args
      .map((arg) =>
        typeof arg === 'string'
          ? arg
          : inspect(arg, { depth: null, colors: false, compact: false })
      )
      .join(' ')}\n`
    stream.write(line)
  }

  console.log = (...args: unknown[]) => {
    originalLog(...args)
    write('INFO', args)
  }
  console.warn = (...args: unknown[]) => {
    originalWarn(...args)
    write('WARN', args)
  }
  console.error = (...args: unknown[]) => {
    originalError(...args)
    write('ERROR', args)
  }

  write('INFO', [`Logging to file: ${logFilePath}`])

  return () => {
    console.log = originalLog
    console.warn = originalWarn
    console.error = originalError
    stream.end()
  }
}
