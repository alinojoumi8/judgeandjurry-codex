import AdmZip from 'adm-zip'
import MsgReader from '@kenjiuno/msgreader'
import mammoth from 'mammoth'
import { simpleParser } from 'mailparser'
import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createReadStream, existsSync } from 'node:fs'
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'

import type { CaseStore } from './db'
import { inferEvidenceType, inferTags } from './evidence'
import type { AppLogger } from './logger'
import { noopLogger } from './logger'
import { nowIso } from './time'
import type {
  CorpusJob,
  CorpusPreview,
  CorpusPreviewEntry,
  DerivedArtifact,
  ManifestEntry,
} from './trialEngineTypes'

const execFileAsync = promisify(execFile)
const previewTtlMs = 30 * 60 * 1000
const maxZipEntries = numberFromEnv('JUDGE_JURY_MAX_CORPUS_FILES', 20_000)
const maxZipExpandedBytes = numberFromEnv('JUDGE_JURY_MAX_ZIP_EXPANDED_BYTES', 4 * 1024 * 1024 * 1024)
const maxZipRatio = numberFromEnv('JUDGE_JURY_MAX_ZIP_RATIO', 200)
const maxExtractedCharacters = numberFromEnv('JUDGE_JURY_MAX_EXTRACTED_CHARACTERS', 5_000_000)
const imageExtensions = new Set(['.png', '.jpg', '.jpeg', '.tif', '.tiff', '.bmp', '.webp', '.gif'])
const audioExtensions = new Set(['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.wma'])
const videoExtensions = new Set(['.mp4', '.mov', '.mkv', '.avi', '.webm', '.m4v', '.wmv'])
const supportedExtensions = new Set([
  '.pdf', '.docx', '.xlsx', '.csv', '.txt', '.md', '.markdown', '.rtf', '.html', '.htm',
  '.eml', '.msg', ...imageExtensions, ...audioExtensions, ...videoExtensions,
])

interface StoredPreview {
  preview: CorpusPreview
  zipPath?: string
}

interface ExtractionResult {
  artifacts: Array<Omit<DerivedArtifact, 'id' | 'manifestEntryId' | 'createdAt'>>
  status: ManifestEntry['status']
  warning?: string
}

export class CorpusEvents {
  private listeners = new Map<string, Set<() => void>>()

  subscribe(jobId: string, listener: () => void): () => void {
    const listeners = this.listeners.get(jobId) ?? new Set()
    listeners.add(listener)
    this.listeners.set(jobId, listeners)
    return () => listeners.delete(listener)
  }

  emit(jobId: string): void {
    for (const listener of this.listeners.get(jobId) ?? []) listener()
  }
}

export class CorpusService {
  readonly events = new CorpusEvents()
  private readonly previews = new Map<string, StoredPreview>()
  private readonly running = new Set<string>()
  private readonly blobRoot: string
  private readonly store: CaseStore
  private readonly logger: AppLogger

  constructor(
    store: CaseStore,
    logger: AppLogger = noopLogger(),
    blobRoot = resolve(process.env.CORPUS_STORAGE_DIR ?? 'data/corpus/blobs'),
  ) {
    this.store = store
    this.logger = logger
    this.blobRoot = blobRoot
    void mkdir(blobRoot, { recursive: true })
    queueMicrotask(() => this.resumePendingJobs())
  }

  async previewFolder(folderPath: string): Promise<CorpusPreview> {
    if (!isAbsolute(folderPath)) throw new Error('Local corpus folder path must be absolute.')
    const root = await realpath(folderPath)
    const rootStats = await stat(root)
    if (!rootStats.isDirectory()) throw new Error('The selected corpus path is not a folder.')
    const files: CorpusPreviewEntry[] = []
    const seenDirectories = new Set<string>()
    await this.scanFolder(root, root, seenDirectories, files)
    return this.rememberPreview(this.buildPreview('folder', root, files))
  }

  async previewZip(zipPath: string): Promise<CorpusPreview> {
    const absolute = resolve(zipPath)
    const zipStats = await stat(absolute)
    if (!zipStats.isFile()) throw new Error('The selected ZIP path is not a file.')
    const zip = new AdmZip(absolute)
    const entries = zip.getEntries().filter((entry) => !entry.isDirectory)
    if (entries.length > maxZipEntries) {
      throw new Error(`ZIP contains ${entries.length} files; the configured limit is ${maxZipEntries}.`)
    }
    const expandedBytes = entries.reduce((sum, entry) => sum + entry.header.size, 0)
    if (expandedBytes > maxZipExpandedBytes) throw new Error('ZIP expansion exceeds the configured safety limit.')
    const files: CorpusPreviewEntry[] = []
    for (const entry of entries) {
      const path = safeZipPath(entry.entryName)
      const encrypted = entry.header.encrypted
      const symlink = (entry.header.fileAttr & 0o170000) === 0o120000
      const compressed = Math.max(entry.header.compressedSize, 1)
      if (entry.header.size / compressed > maxZipRatio) {
        throw new Error(`ZIP entry has an unsafe expansion ratio: ${path}`)
      }
      let status: CorpusPreviewEntry['status'] = extensionSupported(path) ? 'pending' : 'unsupported'
      let warning: string | undefined
      let sha256: string | undefined
      if (symlink) {
        status = 'excluded'
        warning = 'ZIP symbolic-link entries are excluded to prevent path escapes.'
      } else if (encrypted) {
        status = 'locked'
        warning = 'Password-protected ZIP entry is preserved but cannot be extracted without credentials.'
      } else {
        try {
          sha256 = digest(entry.getData())
        } catch (error) {
          status = 'failed'
          warning = errorMessage(error, 'ZIP entry could not be decompressed.')
        }
      }
      files.push({
        relativePath: path,
        sourceReference: path,
        originalName: basename(path),
        mimeType: mimeFor(path),
        size: entry.header.size,
        modifiedAt: entry.header.time?.toISOString(),
        sha256,
        status,
        warning,
        encrypted,
      })
    }
    markDuplicates(files)
    return this.rememberPreview(this.buildPreview('zip', absolute, files), absolute)
  }

  confirmPreview(
    previewId: string,
    matterId: string,
    externalDisclosureConfirmed: boolean,
  ): CorpusJob {
    this.store.getMatter(matterId)
    const stored = this.previews.get(previewId)
    if (!stored || Date.parse(stored.preview.expiresAt) <= Date.now()) {
      this.previews.delete(previewId)
      throw new Error('Corpus preview expired; create a new preview before importing.')
    }
    const job = this.store.workflow.createCorpusJob({
      matterId,
      preview: stored.preview,
      externalDisclosureConfirmed,
      extractorVersions: extractorVersions(),
    })
    this.store.workflow.createManifestEntries(job)
    this.previews.delete(previewId)
    this.start(job.id)
    return job
  }

  start(jobId: string): void {
    if (this.running.has(jobId)) return
    this.running.add(jobId)
    setImmediate(() => {
      this.processJob(jobId)
        .catch((error) => {
          this.logger.error('corpus.job.failed', { jobId, error })
        })
        .finally(() => this.running.delete(jobId))
    })
  }

  async runToCompletion(jobId: string): Promise<CorpusJob> {
    if (this.running.has(jobId)) {
      while (this.running.has(jobId)) await new Promise((resolvePromise) => setTimeout(resolvePromise, 10))
      return this.store.workflow.getCorpusJob(jobId)
    }
    this.running.add(jobId)
    try {
      await this.processJob(jobId)
      return this.store.workflow.getCorpusJob(jobId)
    } finally {
      this.running.delete(jobId)
    }
  }

  getJob(jobId: string): CorpusJob {
    return this.store.workflow.getCorpusJob(jobId)
  }

  listJobs(matterId: string): CorpusJob[] {
    return this.store.workflow.listCorpusJobs(matterId)
  }

  listManifest(jobId: string): ManifestEntry[] {
    return this.store.workflow.listManifestEntries(jobId)
  }

  listArtifacts(entryId: string): DerivedArtifact[] {
    return this.store.workflow.listDerivedArtifacts(entryId)
  }

  private resumePendingJobs(): void {
    for (const job of this.store.workflow.listResumableCorpusJobs()) this.start(job.id)
  }

  private async processJob(jobId: string): Promise<void> {
    let job = this.store.workflow.getCorpusJob(jobId)
    if (job.status === 'completed' || job.status === 'cancelled') return
    job = this.store.workflow.updateCorpusJob(jobId, { status: 'running', error: undefined })
    this.events.emit(jobId)
    const entries = this.store.workflow.listManifestEntries(jobId)
    const pending = new Set(['pending', 'unsupported'])
    let processedFiles = entries.filter((entry) => !pending.has(entry.status)).length
    let processedBytes = entries
      .filter((entry) => !pending.has(entry.status))
      .reduce((sum, entry) => sum + entry.size, 0)
    this.store.workflow.updateCorpusJob(jobId, { processedFiles, processedBytes })
    try {
      for (const entry of entries) {
        if (!pending.has(entry.status)) continue
        await this.processEntry(job, entry)
        processedFiles += 1
        processedBytes += entry.size
        this.store.workflow.updateCorpusJob(jobId, { processedFiles, processedBytes })
        this.events.emit(jobId)
      }
      this.store.workflow.updateCorpusJob(jobId, {
        status: 'completed', processedFiles: entries.length, processedBytes: job.totalBytes,
        completedAt: nowIso(), error: undefined,
      })
      this.logger.info('corpus.job.completed', { jobId, processedFiles: entries.length, processedBytes: job.totalBytes })
    } catch (error) {
      this.store.workflow.updateCorpusJob(jobId, { status: 'failed', error: errorMessage(error) })
      this.logger.error('corpus.job.failed', { jobId, error })
      throw error
    } finally {
      this.events.emit(jobId)
    }
  }

  private async processEntry(job: CorpusJob, entry: ManifestEntry): Promise<void> {
    let bytes: Buffer
    try {
      bytes = await this.readEntryBytes(job, entry)
    } catch (error) {
      this.store.workflow.completeManifestEntry(entry.id, { status: 'failed', warning: errorMessage(error) })
      return
    }
    const sha256 = digest(bytes)
    if (entry.sha256 && entry.sha256 !== sha256) {
      this.store.workflow.completeManifestEntry(entry.id, {
        status: 'failed', warning: 'Source bytes changed after preview; import this corpus again.',
      })
      return
    }
    const storagePath = await this.persistBlob(sha256, bytes)
    this.store.workflow.registerSourceBlob({
      sha256, size: bytes.length, mimeType: entry.mimeType, storagePath,
      manifestEntryId: entry.id, relativePath: entry.relativePath,
    })
    let extraction: ExtractionResult
    try {
      extraction = entry.status === 'unsupported'
        ? unsupportedExtraction(entry)
        : await extractSource(entry, bytes)
    } catch (error) {
      extraction = {
        status: 'needs_review',
        warning: errorMessage(error, 'Text extraction failed; the original is preserved.'),
        artifacts: [metadataArtifact(entry, 'failed', [errorMessage(error)])],
      }
    }
    this.store.workflow.addDerivedArtifacts(entry.id, extraction.artifacts)
    const text = extraction.artifacts.map((artifact) => artifact.text).filter(Boolean).join('\n\n').slice(0, maxExtractedCharacters)
    const evidence = this.store.addEvidence(job.matterId, {
      name: entry.relativePath,
      type: inferEvidenceType(entry.originalName, entry.mimeType),
      mimeType: entry.mimeType,
      size: bytes.length,
      text,
      summary: text
        ? `${entry.relativePath} imported with ${text.length.toLocaleString()} extracted characters.`
        : `${entry.relativePath} preserved; extracted text needs review.`,
      tags: inferTags(`${entry.relativePath} ${text.slice(0, 10_000)}`),
      sha256,
      sourcePath: storagePath,
      ingestionStatus: extraction.status === 'extracted' ? 'stored' : 'extraction_failed',
      extractionWarning: extraction.warning ?? null,
    })
    this.store.workflow.completeManifestEntry(entry.id, {
      sha256, status: extraction.status, warning: extraction.warning, evidenceId: evidence.id,
    })
  }

  private async readEntryBytes(job: CorpusJob, entry: ManifestEntry): Promise<Buffer> {
    if (job.sourceKind === 'folder') {
      const root = await realpath(job.sourceLocator)
      const candidate = resolve(root, ...entry.relativePath.split('/'))
      const actual = await realpath(candidate)
      assertDescendant(root, actual)
      const fileStats = await lstat(actual)
      if (fileStats.isSymbolicLink() || !fileStats.isFile()) throw new Error('Source is not a regular file.')
      return readFile(actual)
    }
    const zip = new AdmZip(job.sourceLocator)
    const zipEntry = zip.getEntry(entry.sourceReference)
    if (!zipEntry) throw new Error(`ZIP entry no longer exists: ${entry.sourceReference}`)
    safeZipPath(zipEntry.entryName)
    if (zipEntry.header.encrypted) throw new Error('ZIP entry is password protected.')
    return zipEntry.getData()
  }

  private async persistBlob(sha256: string, bytes: Buffer): Promise<string> {
    const existing = this.store.workflow.sourceBlob(sha256)
    if (existing) {
      if (!existsSync(existing.storagePath)) throw new Error(`Preserved blob is missing: ${sha256}`)
      return existing.storagePath
    }
    const target = join(this.blobRoot, sha256.slice(0, 2), sha256)
    await mkdir(dirname(target), { recursive: true })
    try {
      await writeFile(target, bytes, { flag: 'wx' })
    } catch (error) {
      if (!isAlreadyExists(error)) throw error
      const existingBytes = await readFile(target)
      if (digest(existingBytes) !== sha256) throw new Error(`Content-addressed blob collision: ${sha256}`)
    }
    return target
  }

  private async scanFolder(
    root: string,
    current: string,
    seenDirectories: Set<string>,
    files: CorpusPreviewEntry[],
  ): Promise<void> {
    const actualDirectory = await realpath(current)
    assertDescendant(root, actualDirectory)
    if (seenDirectories.has(actualDirectory)) return
    seenDirectories.add(actualDirectory)
    const children = await readdir(current, { withFileTypes: true })
    children.sort((a, b) => a.name.localeCompare(b.name))
    for (const child of children) {
      const childPath = join(current, child.name)
      const rel = toPortablePath(relative(root, childPath))
      const childStats = await lstat(childPath)
      if (childStats.isSymbolicLink()) {
        files.push({
          relativePath: rel, sourceReference: childPath, originalName: child.name,
          mimeType: 'application/octet-stream', size: childStats.size,
          modifiedAt: childStats.mtime.toISOString(), status: 'excluded',
          warning: 'Symbolic links and reparse points are excluded to prevent root escapes.',
        })
        continue
      }
      if (childStats.isDirectory()) {
        await this.scanFolder(root, childPath, seenDirectories, files)
        continue
      }
      if (!childStats.isFile()) {
        files.push({
          relativePath: rel, sourceReference: childPath, originalName: child.name,
          mimeType: 'application/octet-stream', size: childStats.size,
          modifiedAt: childStats.mtime.toISOString(), status: 'excluded',
          warning: 'Non-regular filesystem entry was excluded.',
        })
        continue
      }
      let sha256: string | undefined
      let status: CorpusPreviewEntry['status'] = extensionSupported(child.name) ? 'pending' : 'unsupported'
      let warning: string | undefined
      try {
        sha256 = await hashFile(childPath)
      } catch (error) {
        status = 'locked'
        warning = errorMessage(error, 'File is not readable.')
      }
      files.push({
        relativePath: rel, sourceReference: childPath, originalName: child.name,
        mimeType: mimeFor(child.name), size: childStats.size,
        modifiedAt: childStats.mtime.toISOString(), sha256, status, warning,
      })
    }
    markDuplicates(files)
  }

  private buildPreview(sourceKind: CorpusPreview['sourceKind'], sourceLocator: string, files: CorpusPreviewEntry[]): CorpusPreview {
    const id = randomUUID()
    return {
      id, sourceKind, sourceLocator, files,
      fileCount: files.length,
      totalSize: files.reduce((sum, file) => sum + file.size, 0),
      unsupportedCount: files.filter((file) => file.status === 'unsupported').length,
      duplicateCount: files.filter((file) => Boolean(file.duplicateOf)).length,
      encryptedCount: files.filter((file) => file.encrypted || file.status === 'locked').length,
      proposedExclusions: files.filter((file) => file.status === 'excluded').map((file) => file.relativePath),
      warnings: previewWarnings(files),
      expiresAt: new Date(Date.now() + previewTtlMs).toISOString(),
    }
  }

  private rememberPreview(preview: CorpusPreview, zipPath?: string): CorpusPreview {
    this.previews.set(preview.id, { preview, zipPath })
    this.prunePreviews()
    return preview
  }

  private prunePreviews(): void {
    for (const [id, item] of this.previews) {
      if (Date.parse(item.preview.expiresAt) <= Date.now()) this.previews.delete(id)
    }
  }
}

async function extractSource(entry: ManifestEntry, bytes: Buffer): Promise<ExtractionResult> {
  const extension = extname(entry.originalName).toLowerCase()
  if (extension === '.pdf') return extractPdf(entry, bytes)
  if (extension === '.docx') return extractDocx(entry, bytes)
  if (extension === '.xlsx') return extractXlsx(entry, bytes)
  if (extension === '.eml') return extractEml(entry, bytes)
  if (extension === '.msg') return extractMsg(entry, bytes)
  if (imageExtensions.has(extension)) return extractImage(entry, bytes)
  if (audioExtensions.has(extension) || videoExtensions.has(extension)) return extractMedia(entry, bytes)
  if (extension === '.html' || extension === '.htm') return textExtraction(stripHtml(bytes.toString('utf8')), 'html', '1', { document: 1 })
  if (extension === '.rtf') return textExtraction(stripRtf(bytes.toString('utf8')), 'rtf', '1', { document: 1 })
  return textExtraction(bytes.toString('utf8').replaceAll('\u0000', ' '), extension.slice(1) || 'text', '1', { document: 1 })
}

async function extractPdf(entry: ManifestEntry, bytes: Buffer): Promise<ExtractionResult> {
  const { PDFParse } = await import('pdf-parse')
  const parser = new PDFParse({ data: bytes })
  try {
    const result = await parser.getText()
    const artifacts = result.pages.map((page, index) => artifact(
      'page', { page: page.num }, page.text, 'pdf-parse', '2.4.5', [], page.text.trim() ? 1 : 0.5, index,
    ))
    const emptyPageNumbers = result.pages.filter((page) => !page.text.trim()).map((page) => page.num)
    if (artifacts.length === 0) {
      return {
        status: 'needs_review',
        warning: 'PDF contains no readable pages; the preserved source requires manual review.',
        artifacts: [metadataArtifact(entry, 'needs_review', ['No readable PDF pages.'])],
      }
    }
    const ocrWarnings: string[] = []
    if (emptyPageNumbers.length > 0) {
      try {
        const { recognize } = await import('tesseract.js')
        for (const pageNumber of emptyPageNumbers) {
          const screenshot = await parser.getScreenshot({ partial: [pageNumber], desiredWidth: 1800 })
          const page = screenshot.pages[0]
          if (!page) {
            ocrWarnings.push(`Page ${pageNumber} could not be rendered for OCR.`)
            continue
          }
          const result = await recognize(Buffer.from(page.data), 'eng')
          const confidence = Math.max(0, Math.min(1, result.data.confidence / 100))
          const target = artifacts.find((item) => item.locator.page === pageNumber)
          if (!target) continue
          target.text = result.data.text.slice(0, maxExtractedCharacters)
          target.extractorName = 'pdf-parse+tesseract.js'
          target.extractorVersion = '2.4.5+7.0.0'
          target.reliability = confidence
          target.status = confidence >= 0.5 && target.text.trim() ? 'extracted' : 'needs_review'
          target.warnings = ['OCR-derived PDF text; verify legally significant wording against the preserved page image.']
          if (confidence < 0.75) ocrWarnings.push(`Page ${pageNumber} OCR confidence is low (${Math.round(confidence * 100)}%).`)
        }
      } catch (error) {
        ocrWarnings.push(`Scanned-page OCR failed: ${errorMessage(error)}`)
      }
    }
    const remainingEmpty = artifacts.filter((item) => !item.text.trim()).length
    return {
      status: remainingEmpty > 0 || ocrWarnings.length > 0 ? 'needs_review' : 'extracted',
      warning: remainingEmpty > 0
        ? `${remainingEmpty} PDF page(s) remained unreadable after local OCR.${ocrWarnings.length ? ` ${ocrWarnings.join(' ')}` : ''}`
        : ocrWarnings.length > 0 ? ocrWarnings.join(' ') : undefined,
      artifacts,
    }
  } finally {
    await parser.destroy()
  }
}

async function extractDocx(_entry: ManifestEntry, bytes: Buffer): Promise<ExtractionResult> {
  const result = await mammoth.extractRawText({ buffer: bytes })
  const warnings = result.messages.map((message) => message.message)
  const extracted = textExtraction(result.value, 'mammoth', '1.12.0', { document: 1 }, warnings)
  return warnings.length > 0 ? { ...extracted, status: 'needs_review', warning: warnings.join(' ') } : extracted
}

function extractXlsx(_entry: ManifestEntry, bytes: Buffer): ExtractionResult {
  const zip = new AdmZip(bytes)
  const sharedStrings = parseSharedStrings(zip.readAsText('xl/sharedStrings.xml') || '')
  const workbook = zip.readAsText('xl/workbook.xml') || ''
  const rels = zip.readAsText('xl/_rels/workbook.xml.rels') || ''
  const relationshipTargets = new Map<string, string>()
  for (const match of rels.matchAll(/<Relationship\b[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)) {
    relationshipTargets.set(match[1], match[2])
  }
  const artifacts: ExtractionResult['artifacts'] = []
  let index = 0
  for (const match of workbook.matchAll(/<sheet\b[^>]*name="([^"]+)"[^>]*(?:r:id|id)="([^"]+)"[^>]*\/?>(?:<\/sheet>)?/g)) {
    const sheetName = decodeXml(match[1])
    const target = relationshipTargets.get(match[2])
    if (!target) continue
    const normalizedTarget = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`
    const xml = zip.readAsText(normalizedTarget)
    const lines: string[] = []
    for (const cell of xml.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = cell[1]
      const body = cell[2]
      const ref = /\br="([^"]+)"/.exec(attrs)?.[1] ?? '?'
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1]
      const raw = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? /<t[^>]*>([\s\S]*?)<\/t>/.exec(body)?.[1] ?? ''
      const value = type === 's' ? sharedStrings[Number(raw)] ?? raw : decodeXml(raw)
      if (value) lines.push(`${ref}: ${value}`)
    }
    artifacts.push(artifact('sheet', { sheet: sheetName }, lines.join('\n'), 'judge-jury-xlsx', '1', [], 1, index++))
  }
  if (artifacts.length === 0) {
    return { status: 'needs_review', warning: 'Workbook contained no readable worksheets.', artifacts: [artifact('metadata', { workbook: 1 }, '', 'judge-jury-xlsx', '1', ['No readable worksheets.'], 0.4, 0)] }
  }
  return { status: 'extracted', artifacts }
}

async function extractEml(_entry: ManifestEntry, bytes: Buffer): Promise<ExtractionResult> {
  const message = await simpleParser(bytes)
  const header = [
    `Subject: ${message.subject ?? ''}`,
    `From: ${message.from?.text ?? ''}`,
    `To: ${message.to ? String(message.to) : ''}`,
    `Date: ${message.date?.toISOString() ?? ''}`,
  ].join('\n')
  const artifacts = [artifact('email', { message: 1 }, `${header}\n\n${message.text ?? stripHtml(message.html || '')}`, 'mailparser', '3.9.14', [], 1, 0)]
  message.attachments.forEach((attachment, index) => {
    artifacts.push(artifact(
      'metadata', { attachment: index + 1, filename: attachment.filename ?? `attachment-${index + 1}` },
      `Attachment: ${attachment.filename ?? 'unnamed'} (${attachment.contentType}, ${attachment.size} bytes)`,
      'mailparser', '3.9.14', ['Attachment remains preserved inside the source EML.'], 0.9, index + 1,
    ))
  })
  return { status: 'extracted', artifacts }
}

function extractMsg(_entry: ManifestEntry, bytes: Buffer): ExtractionResult {
  const view = Uint8Array.from(bytes).buffer
  const message = new MsgReader(view).getFileData()
  const recipients = (message.recipients ?? []).map((recipient) => recipient.email ?? recipient.name).filter(Boolean).join(', ')
  const text = [
    `Subject: ${message.subject ?? ''}`,
    `From: ${message.senderName ?? ''} <${message.senderEmail ?? ''}>`,
    `To: ${recipients}`,
    `Date: ${message.clientSubmitTime ?? message.creationTime ?? ''}`,
    '',
    message.body ?? '',
  ].join('\n')
  const artifacts = [artifact('email', { message: 1 }, text, '@kenjiuno/msgreader', '1.28.0', [], 1, 0)]
  ;(message.attachments ?? []).forEach((attachment, index) => {
    artifacts.push(artifact(
      'metadata', { attachment: index + 1, filename: attachment.fileName ?? attachment.name ?? `attachment-${index + 1}` },
      `Attachment: ${attachment.fileName ?? attachment.name ?? 'unnamed'} (${attachment.contentLength ?? 0} bytes)`,
      '@kenjiuno/msgreader', '1.28.0', ['Attachment remains preserved inside the source MSG.'], 0.9, index + 1,
    ))
  })
  return { status: text.trim() ? 'extracted' : 'needs_review', warning: text.trim() ? undefined : 'MSG contained no readable message body.', artifacts }
}

async function extractImage(_entry: ManifestEntry, bytes: Buffer): Promise<ExtractionResult> {
  try {
    const { recognize } = await import('tesseract.js')
    const result = await recognize(bytes, 'eng')
    const confidence = Math.max(0, Math.min(1, result.data.confidence / 100))
    const warnings = confidence < 0.75 ? ['OCR confidence is low; compare the text with the original image.'] : ['OCR is derived text; verify legally significant wording against the original image.']
    return {
      status: confidence < 0.5 ? 'needs_review' : 'extracted',
      warning: confidence < 0.75 ? warnings[0] : undefined,
      artifacts: [artifact('image_region', { region: 'full-image' }, result.data.text, 'tesseract.js', '7.0.0', warnings, confidence, 0)],
    }
  } catch (error) {
    return {
      status: 'needs_review', warning: `Local OCR failed: ${errorMessage(error)}`,
      artifacts: [artifact('metadata', { image: 1 }, '', 'tesseract.js', '7.0.0', ['OCR unavailable; original image preserved.'], 0.2, 0)],
    }
  }
}

async function extractMedia(entry: ManifestEntry, bytes: Buffer): Promise<ExtractionResult> {
  const work = await mkdtemp(join(tmpdir(), 'judge-jury-media-'))
  const source = join(work, `source${extname(entry.originalName)}`)
  try {
    await writeFile(source, bytes)
    const metadata = await mediaMetadata(source)
    const whisper = process.env.WHISPER_PATH ?? 'whisper'
    await execFileAsync(whisper, [source, '--model', process.env.WHISPER_MODEL ?? 'base', '--output_format', 'txt', '--output_dir', work], {
      timeout: numberFromEnv('JUDGE_JURY_WHISPER_TIMEOUT_MS', 30 * 60 * 1000),
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    })
    const transcriptPath = join(work, `${basename(source, extname(source))}.txt`)
    const transcript = await readFile(transcriptPath, 'utf8')
    const duration = typeof metadata.format === 'object' && metadata.format !== null && 'duration' in metadata.format
      ? Number(metadata.format.duration ?? 0)
      : 0
    return {
      status: transcript.trim() ? 'extracted' : 'needs_review',
      warning: transcript.trim() ? undefined : 'Whisper returned an empty transcript.',
      artifacts: [
        artifact('metadata', { media: 1 }, JSON.stringify(metadata), 'ffprobe', 'local', [], 1, 0),
        artifact('transcript', { startSeconds: 0, endSeconds: duration }, transcript, 'whisper', process.env.WHISPER_MODEL ?? 'base', ['Machine transcript; verify timestamps and legally significant wording against the recording.'], 0.75, 1),
      ],
    }
  } catch (error) {
    return {
      status: 'needs_review', warning: `Media transcription blocked: ${errorMessage(error)}`,
      artifacts: [artifact('metadata', { media: 1 }, '', 'ffmpeg/whisper', 'local', ['Required local media tool is unavailable or failed.'], 0.2, 0)],
    }
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

async function mediaMetadata(path: string): Promise<Record<string, unknown>> {
  const ffprobe = process.env.FFPROBE_PATH ?? 'ffprobe'
  const result = await execFileAsync(ffprobe, ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', path], {
    timeout: 60_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true,
  })
  return JSON.parse(result.stdout) as Record<string, unknown>
}

function textExtraction(text: string, extractorName: string, extractorVersion: string, locator: Record<string, string | number>, warnings: string[] = []): ExtractionResult {
  const normalizedText = text.replace(/\r\n/g, '\n').trim()
  return {
    status: normalizedText ? 'extracted' : 'needs_review',
    warning: normalizedText ? undefined : 'File contained no readable text.',
    artifacts: [artifact('text', locator, normalizedText, extractorName, extractorVersion, warnings, normalizedText ? 1 : 0.4, 0)],
  }
}

function unsupportedExtraction(entry: ManifestEntry): ExtractionResult {
  const warning = `No extractor is available for ${extname(entry.originalName) || 'this file type'}; original bytes are preserved.`
  return { status: 'unsupported', warning, artifacts: [metadataArtifact(entry, 'needs_review', [warning])] }
}

function metadataArtifact(entry: Pick<ManifestEntry, 'relativePath' | 'mimeType' | 'size'>, status: DerivedArtifact['status'], warnings: string[]): Omit<DerivedArtifact, 'id' | 'manifestEntryId' | 'createdAt'> {
  return {
    kind: 'metadata', locator: { path: entry.relativePath },
    text: `${entry.relativePath} (${entry.mimeType}, ${entry.size} bytes)`, status,
    reliability: 1, extractorName: 'judge-jury-metadata', extractorVersion: '1', warnings, orderIndex: 0,
  }
}

function artifact(
  kind: DerivedArtifact['kind'], locator: Record<string, string | number>, text: string,
  extractorName: string, extractorVersion: string, warnings: string[], reliability: number, orderIndex: number,
): Omit<DerivedArtifact, 'id' | 'manifestEntryId' | 'createdAt'> {
  return { kind, locator, text: text.slice(0, maxExtractedCharacters), status: warnings.length ? 'needs_review' : 'extracted', reliability, extractorName, extractorVersion, warnings, orderIndex }
}

function parseSharedStrings(xml: string): string[] {
  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((match) =>
    [...match[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((part) => decodeXml(part[1])).join(''),
  )
}

function stripHtml(value: string): string {
  return decodeXml(value.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()
}

function stripRtf(value: string): string {
  return value
    .replace(/\\'[0-9a-fA-F]{2}/g, (hex) => String.fromCharCode(Number.parseInt(hex.slice(2), 16)))
    .replace(/\\(?:par|line)\b/g, '\n')
    .replace(/\\[a-zA-Z]+-?\d* ?/g, '')
    .replace(/[{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function decodeXml(value: string): string {
  return value.replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&apos;', "'").replaceAll('&amp;', '&')
}

export function safeZipPath(input: string): string {
  if (input.includes('\u0000') || input.includes('\\') || /^[a-zA-Z]:/.test(input) || input.startsWith('/')) {
    throw new Error(`Unsafe ZIP path: ${input}`)
  }
  const normalizedPath = normalize(input).replaceAll('\\', '/')
  if (normalizedPath === '..' || normalizedPath.startsWith('../') || normalizedPath.split('/').includes('..')) {
    throw new Error(`ZIP traversal path rejected: ${input}`)
  }
  return normalizedPath.replace(/^\.\//, '')
}

function assertDescendant(root: string, candidate: string): void {
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`
  if (candidate !== root && !candidate.startsWith(prefix)) throw new Error('Filesystem path escapes the approved corpus root.')
}

function extensionSupported(path: string): boolean {
  return supportedExtensions.has(extname(path).toLowerCase())
}

function mimeFor(path: string): string {
  const extension = extname(path).toLowerCase()
  const mimes: Record<string, string> = {
    '.pdf': 'application/pdf', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.csv': 'text/csv',
    '.txt': 'text/plain', '.md': 'text/markdown', '.markdown': 'text/markdown', '.rtf': 'application/rtf',
    '.html': 'text/html', '.htm': 'text/html', '.eml': 'message/rfc822', '.msg': 'application/vnd.ms-outlook',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.tif': 'image/tiff', '.tiff': 'image/tiff',
    '.bmp': 'image/bmp', '.webp': 'image/webp', '.gif': 'image/gif', '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
    '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.wma': 'audio/x-ms-wma',
    '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo',
    '.webm': 'video/webm', '.m4v': 'video/x-m4v', '.wmv': 'video/x-ms-wmv',
  }
  return mimes[extension] ?? 'application/octet-stream'
}

function markDuplicates(files: CorpusPreviewEntry[]): void {
  const firstByHash = new Map<string, string>()
  for (const file of files) {
    if (!file.sha256) continue
    const first = firstByHash.get(file.sha256)
    if (first) file.duplicateOf = first
    else firstByHash.set(file.sha256, file.relativePath)
  }
}

function previewWarnings(files: CorpusPreviewEntry[]): string[] {
  const warnings: string[] = []
  const locked = files.filter((file) => file.status === 'locked').length
  const unsupported = files.filter((file) => file.status === 'unsupported').length
  const excluded = files.filter((file) => file.status === 'excluded').length
  if (locked) warnings.push(`${locked} locked or unreadable file(s) will remain preserved but unextracted.`)
  if (unsupported) warnings.push(`${unsupported} unsupported file(s) will remain preserved for review or conversion.`)
  if (excluded) warnings.push(`${excluded} unsafe filesystem or ZIP entry/entries are proposed for exclusion.`)
  return warnings
}

function extractorVersions(): Record<string, string> {
  return {
    'pdf-parse': '2.4.5', mammoth: '1.12.0', 'judge-jury-xlsx': '1',
    mailparser: '3.9.14', '@kenjiuno/msgreader': '1.28.0', 'tesseract.js': '7.0.0',
    ffprobe: process.env.FFPROBE_PATH ?? 'local', whisper: process.env.WHISPER_MODEL ?? 'base',
  }
}

async function hashFile(path: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolvePromise(hash.digest('hex')))
  })
}

function digest(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function toPortablePath(path: string): string {
  return path.replaceAll('\\', '/')
}

function errorMessage(error: unknown, fallback = 'Corpus operation failed.'): string {
  return error instanceof Error && error.message ? error.message : fallback
}

function numberFromEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name])
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST'
}

// Exported for route-level deletion safety and focused tests.
export function corpusStorageRoot(): string {
  return resolve(process.env.CORPUS_STORAGE_DIR ?? 'data/corpus/blobs')
}

export function isCorpusBlobPath(path: string): boolean {
  const root = corpusStorageRoot()
  const target = resolve(path)
  return target === root || target.startsWith(`${root}${sep}`)
}

export async function restoreCorpusBlob(sha256: string, bytes: Buffer): Promise<string> {
  if (!/^[a-f0-9]{64}$/.test(sha256) || digest(bytes) !== sha256) {
    throw new Error(`Archived corpus blob checksum is invalid: ${sha256}`)
  }
  const target = join(corpusStorageRoot(), sha256.slice(0, 2), sha256)
  await mkdir(dirname(target), { recursive: true })
  try {
    await writeFile(target, bytes, { flag: 'wx' })
  } catch (error) {
    if (!isAlreadyExists(error)) throw error
    if (digest(await readFile(target)) !== sha256) throw new Error(`Content-addressed blob collision: ${sha256}`)
  }
  return target
}
