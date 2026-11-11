import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { CaseStore } from '../server/db'
import { CaseWorkflowService } from '../server/caseWorkflow'
import { CorpusService } from '../server/corpus'

const root = fileURLToPath(new URL('../samples/civil-negligence/', import.meta.url))
const read = (path: string) => readFileSync(join(root, path), 'utf8').replace(/\r\n/g, '\n')
const sourceNames = readdirSync(join(root, 'sources')).filter((name) => name.endsWith('.txt')).sort()
const sources = new Map(sourceNames.map((name) => [name, read(`sources/${name}`)]))
const fileNo = (name: string) => name.slice(0, 2)

const ref = z.object({ file: z.string(), quote: z.string() }).strict()
const amount = z.object({ label: z.string(), amountCents: z.number().int(), quote: z.string() }).strict()
const loss = z.object({ file: z.string(), items: z.array(amount), totalCents: z.number().int(), totalQuote: z.string() }).strict()
const when = z.object({
  precision: z.enum(['exact', 'day', 'month', 'year', 'range', 'approximate', 'unknown']),
  start: z.string().optional(), end: z.string().optional(), original: z.string(),
}).strict()
const keySchema = z.object({
  schemaVersion: z.literal(1), fictional: z.literal(true), note: z.string(),
  parties: z.array(z.object({ id: z.string(), name: z.string(), role: z.enum(['plaintiff', 'defendant']) }).strict()),
  pleadings: z.array(z.object({
    id: z.string(), kind: z.enum(['claim', 'allegation', 'defence', 'crossclaim', 'relief']), by: z.string(),
    against: z.array(z.string()), summary: z.string(), source: ref.extend({ paragraph: z.number().int() }).strict(),
  }).strict()),
  chronology: z.array(z.object({
    id: z.string(), when, description: z.string(),
    type: z.enum(['incident', 'treatment', 'communication', 'financial', 'procedural', 'other']),
    assertion: z.enum(['record', 'testimony', 'allegation', 'inference']), sources: z.array(ref).min(1),
  }).strict()),
  conflicts: z.array(z.object({
    id: z.string(), topic: z.string(), sides: z.array(ref.extend({ says: z.string() }).strict()),
    resolvableFromRecord: z.boolean(), note: z.string().optional(),
  }).strict()),
  gaps: z.array(z.object({ id: z.string(), description: z.string(), pointer: ref, absentFilePattern: z.string().optional() }).strict()),
  experts: z.array(z.object({
    id: z.string(), name: z.string(), retainedBy: z.string(), field: z.string(), file: z.string(), qualificationsStated: z.boolean(),
    opinions: z.array(z.object({ summary: z.string(), file: z.string(), quote: z.string() }).strict()),
    plantedWeaknesses: z.array(z.object({ description: z.string(), file: z.string(), quote: z.string() }).strict()),
  }).strict()),
  economicLoss: z.object({
    specialDamages: loss, expertEstimate: loss,
    reportedIncome: z.array(z.object({ year: z.number().int(), amountCents: z.number().int(), file: z.string(), quote: z.string() }).strict()),
    pleadedRelief: z.array(z.object({ label: z.string(), amountCents: z.number().int(), file: z.string(), quote: z.string() }).strict()),
  }).strict(),
  injection: z.object({ file: z.string(), line: z.string(), canary: z.string(), expectedBehaviour: z.string() }).strict(),
}).strict()
type Key = z.infer<typeof keySchema>

const key: Key = keySchema.parse(JSON.parse(read('answer-key.json')))

// Every { file, quote } pair in the key. A quote inherits the nearest enclosing `file`.
function collectRefs(node: unknown, inherited?: string, out: Array<{ file: string; quote: string }> = []) {
  if (Array.isArray(node)) node.forEach((child) => collectRefs(child, inherited, out))
  else if (node && typeof node === 'object') {
    const record = node as Record<string, unknown>
    const file = typeof record.file === 'string' ? record.file : inherited
    for (const field of ['quote', 'totalQuote', 'line']) {
      if (typeof record[field] === 'string') out.push({ file: file!, quote: record[field] as string })
    }
    Object.values(record).forEach((child) => collectRefs(child, file, out))
  }
  return out
}
const lineWith = (file: string, quote: string) => sources.get(file)!.split('\n').find((line) => line.includes(quote))

describe('civil negligence fixture: static integrity', () => {
  it('has 19 fictional sources and a key that parses', () => {
    expect(sourceNames).toHaveLength(19)
    for (const [name, text] of sources) expect(text.startsWith('FICTIONAL TEST SOURCE: '), name).toBe(true)
    expect(key.fictional).toBe(true)
  })

  it('resolves every file and quote, and cites every source', () => {
    const refs = collectRefs(key)
    expect(refs.length).toBeGreaterThan(100)
    for (const { file, quote } of refs) {
      expect(sources.has(file), `missing file ${file}`).toBe(true)
      expect(quote.includes('\n'), quote).toBe(false)
      expect(sources.get(file)!.includes(quote), `${file}: ${quote}`).toBe(true)
    }
    const cited = new Set(refs.map((item) => item.file))
    expect(sourceNames.filter((name) => !cited.has(name))).toEqual([])
  })

  it('ties each pleading to a numbered paragraph and known parties', () => {
    const ids = new Set(key.parties.map((party) => party.id))
    expect(key.pleadings.length).toBeGreaterThanOrEqual(15)
    for (const pleading of key.pleadings) {
      const line = lineWith(pleading.source.file, pleading.source.quote)
      expect(line?.startsWith(`${pleading.source.paragraph}. `), pleading.id).toBe(true)
      for (const id of [pleading.by, ...pleading.against]) expect(ids.has(id), `${pleading.id}: ${id}`).toBe(true)
    }
  })

  it('keeps chronology assertions inside the allowed sources', () => {
    expect(key.chronology.length).toBeGreaterThanOrEqual(25)
    expect(new Set(key.chronology.map((event) => event.type)).size).toBe(6)
    for (const event of key.chronology) {
      const numbers = event.sources.map((source) => Number(fileNo(source.file)))
      if (event.assertion === 'allegation') expect(numbers.every((n) => n >= 1 && n <= 3), event.id).toBe(true)
      if (event.assertion === 'testimony') expect(numbers.every((n) => n === 15 || n === 16), event.id).toBe(true)
      if (event.assertion === 'record' && event.type !== 'procedural') expect(numbers.some((n) => n <= 3), event.id).toBe(false)
    }
    const fall = key.chronology.find((event) => event.type === 'incident' && event.when.start === '2025-01-14')
    expect(fall?.when.precision).toBe('day')
    const inferences = key.chronology.filter((event) => event.assertion === 'inference')
    expect(inferences).toHaveLength(1)
    expect(inferences[0].sources.map((source) => fileNo(source.file)).sort()).toEqual(['05', '08'])
    const days = (Date.parse(inferences[0].when.start!) - Date.parse(fall!.when.start!)) / 86_400_000
    expect(days).toBe(65)
    expect(inferences[0].description).toContain('65 days')
  })

  it('records exactly ten conflicts and five gaps', () => {
    expect(key.conflicts.map((conflict) => conflict.id)).toEqual(['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9', 'C10'])
    for (const conflict of key.conflicts) {
      expect(conflict.sides.length, conflict.id).toBeGreaterThanOrEqual(2)
      expect(new Set(conflict.sides.map((side) => side.file)).size, conflict.id).toBeGreaterThanOrEqual(2)
    }
    expect(key.gaps.map((gap) => gap.id)).toEqual(['G1', 'G2', 'G3', 'G4', 'G5'])
    for (const gap of key.gaps.filter((item) => item.absentFilePattern)) {
      expect(sourceNames.some((name) => new RegExp(gap.absentFilePattern!, 'i').test(name)), gap.id).toBe(false)
    }
  })

  it('leaves no physiotherapy entry inside the recorded gap', () => {
    const entries = sources.get(sourceNames.find((name) => fileNo(name) === '11')!)!
      .split('\n').map((line) => /^(\d{4}-\d{2}-\d{2}):/.exec(line)?.[1]).filter(Boolean) as string[]
    expect(entries.length).toBeGreaterThanOrEqual(4)
    expect(entries.filter((date) => date >= '2025-04-02' && date <= '2025-07-28')).toEqual([])
  })

  it('plants the injection line once and keeps the canary out of the prompts', () => {
    const all = [...sources.values()].join('\n')
    expect(all.split(key.injection.line).length - 1).toBe(1)
    expect(sources.get(key.injection.file)!.includes(key.injection.line)).toBe(true)
    expect(all.split(key.injection.canary).length - 1).toBe(1)
    for (const name of ['README.md', 'scenario.txt']) expect(read(name)).not.toContain(key.injection.canary)
  })

  it('adds up the money and states expert qualifications only where recorded', () => {
    for (const group of [key.economicLoss.specialDamages, key.economicLoss.expertEstimate]) {
      expect(group.items.reduce((sum, item) => sum + item.amountCents, 0)).toBe(group.totalCents)
    }
    expect(key.economicLoss.pleadedRelief).toHaveLength(3)
    expect(key.economicLoss.reportedIncome).toHaveLength(4)
    expect(key.experts).toHaveLength(3)
    for (const expert of key.experts) {
      expect(/qualification|curriculum vitae|\bcv\b/i.test(sources.get(expert.file)!), expert.name).toBe(expert.qualificationsStated)
    }
  })
})

describe('civil negligence fixture: real application code', () => {
  const roots: string[] = []
  afterEach(() => {
    for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  async function importFixture() {
    const dir = mkdtempSync(join(tmpdir(), 'triallens-civil-'))
    roots.push(dir)
    const store = new CaseStore(join(dir, 'case.db'))
    const matter = store.createMatter({ title: 'Civil negligence fixture' })
    const service = new CorpusService(store, undefined, join(dir, 'blobs'))
    const preview = await service.previewFolder(join(root, 'sources'))
    const completed = await service.runToCompletion(service.confirmPreview(preview.id, matter.id, false).id)
    return { store, matter, service, completed }
  }

  it('imports all 19 sources with no warning and keeps every quoted line', async () => {
    const { store, matter, service, completed } = await importFixture()
    try {
      expect(completed.status).toBe('completed')
      const manifest = service.listManifest(completed.id)
      expect(manifest).toHaveLength(19)
      for (const entry of manifest) {
        expect(entry.status, entry.relativePath).toBe('extracted')
        expect(entry.warning, entry.relativePath).toBeUndefined()
      }
      const evidence = store.listEvidence(matter.id, true)
      expect(evidence).toHaveLength(19)
      const text = new Map(evidence.map((item) => [item.name.replaceAll('\\', '/').split('/').at(-1)!, item.text.replace(/\r\n/g, '\n')]))
      for (const { file, quote } of collectRefs(key)) expect(text.get(file)?.includes(quote), `${file}: ${quote}`).toBe(true)
    } finally {
      store.close()
    }
  })

  it('flags only the economic-loss report for missing expert foundation', async () => {
    const { store, matter } = await importFixture()
    try {
      const findings = new CaseWorkflowService(store).analyzeDisclosure(matter.id)
      const byId = new Map(store.listEvidence(matter.id, true).map((item) => [item.id, item.name.replaceAll('\\', '/').split('/').at(-1)!]))
      const flagged = findings
        .filter((finding) => finding.category === 'expert_foundation')
        .flatMap((finding) => finding.sourceRefs.map((source) => byId.get(source.evidenceId!)))
      expect(flagged).toEqual(['14-expert-report-economic-loss.txt'])
    } finally {
      store.close()
    }
  })
})
