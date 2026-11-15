import { afterEach, describe, expect, it } from 'vitest'

import {
  checkWhen,
  ChronologyError,
  ChronologyService,
  datesConflict,
  descriptionOverlap,
  flagConflicts,
  mergeDrafts,
  prepareDocumentEvents,
  rankKeyFacts,
  whenShapeErrors,
  type ChronologyContent,
  type ChronologyEvent,
  type ChronologyWhen,
  type ModelEvent,
} from '../server/analysis/chronology'
import { checkPassage } from '../server/analysis/sourceCheck'
import { StructuredModelError, type StructuredRequest } from '../server/analysis/structured'
import type { EvidenceItem } from '../server/types'
import { addSource, cleanupAnalysisFixtures, memoryStore } from './analysisFixtures'
import {
  answerKey,
  buildCivilWorld,
  chronologyRouter,
  documentOf,
  fallDescription,
  routedClient,
  type CivilWorld,
  type Router,
} from './intelligenceFixtures'

afterEach(cleanupAnalysisFixtures)

function evidenceOf(text: string, extra: Partial<EvidenceItem> = {}): EvidenceItem {
  return {
    id: 'ev-1', matterId: 'm', exhibitId: 'E-001', name: 'note.txt', type: 'text', mimeType: 'text/plain', size: text.length, text, summary: '',
    tags: [], uploadedAt: '2026-01-01T00:00:00.000Z', sha256: null, sourceAvailable: true, ingestionStatus: 'stored', extractionWarning: null, archivedAt: null, ...extra,
  }
}

const ref = (item: EvidenceItem, quote: string, paragraph = 1) => ({ evidenceId: item.id, paragraph, quote })

async function generated(world: CivilWorld, router: Router = chronologyRouter(world)) {
  const client = routedClient(router)
  const service = new ChronologyService(world.store, world.service, world.workflow)
  const artifact = await service.generate(world.matterId, { client })
  return { service, client, artifact, content: artifact.content as unknown as ChronologyContent }
}

describe('F1 checkWhen: a date must be supported by the cited passage', () => {
  const item = evidenceOf([
    'Report completed: March 3, 2023.', 'Seen at approximately 7:45 a.m. by staff.', 'Received 04/05/2023 by mail.',
    'Triage 10:12: patient arrived.', 'Received 04/05/2023 by mail; the cover note is dated April 5, 2023.',
  ].join('\n\n'))
  const cited = (quote: string) => {
    const paragraph = quote.startsWith('Seen') ? 2 : quote.startsWith('Triage') ? 4 : quote.startsWith('Received 04/05/2023 by mail;') ? 5 : quote.startsWith('Received') ? 3 : 1
    return [{ item, ref: ref(item, quote, paragraph) }]
  }

  it('keeps a supported date as the model gave it (valid control)', () => {
    const when: ChronologyWhen = { precision: 'day', start: '2023-03-03', original: 'March 3, 2023' }
    expect(checkWhen(when, cited('Report completed: March 3, 2023.'))).toEqual({ when, warnings: [] })
  })

  it('downgrades a date whose original text is not in the cited passage and keeps the original', () => {
    const result = checkWhen({ precision: 'day', start: '2023-03-03', original: 'March 4, 2023' }, cited('Report completed: March 3, 2023.'))
    expect(result.when).toEqual({ precision: 'unknown', original: 'March 4, 2023' })
    expect(result.warnings[0]).toMatch(/original text does not appear/)
  })

  it('downgrades a day the passage never states, even when the original text is present', () => {
    const result = checkWhen({ precision: 'day', start: '2023-03-09', original: 'March 3, 2023' }, cited('Report completed: March 3, 2023.'))
    expect(result.when.precision).toBe('unknown')
    expect(result.when.start).toBeUndefined()
    expect(result.warnings[0]).toMatch(/does not state this date/)
  })

  it('never lets a model resolve an ambiguous numeric date, even if another date in the paragraph would fit', () => {
    for (const quote of ['Received 04/05/2023 by mail.', 'Received 04/05/2023 by mail; the cover note is dated April 5, 2023.']) {
      const result = checkWhen({ precision: 'day', start: '2023-04-05', original: '04/05/2023' }, cited(quote))
      expect(result.when).toEqual({ precision: 'unknown', original: '04/05/2023' })
      expect(result.warnings[0]).toMatch(/ambiguous numeric date/)
    }
    // Valid control: the same day written in words is not ambiguous.
    expect(checkWhen({ precision: 'day', start: '2023-04-05', original: 'April 5, 2023' }, cited('Received 04/05/2023 by mail; the cover note is dated April 5, 2023.')).warnings).toEqual([])
  })

  it('drops an unsupported time of day but keeps the supported day', () => {
    const when: ChronologyWhen = { precision: 'exact', start: '2023-03-03T09:30', original: 'March 3, 2023' }
    const result = checkWhen(when, [{ item, ref: ref(item, 'Report completed: March 3, 2023.') }])
    expect(result.when).toEqual({ precision: 'day', start: '2023-03-03', original: 'March 3, 2023' })
    expect(result.warnings[0]).toMatch(/time of day was dropped/)
  })

  it('leaves a time with no date in the passage unknown', () => {
    const result = checkWhen({ precision: 'exact', start: '2023-03-03T10:12', original: 'Triage 10:12' }, cited('Triage 10:12: patient arrived.'))
    expect(result.when.precision).toBe('unknown')
  })

  it('downgrades a malformed date and never accepts a start on an unknown date', () => {
    expect(checkWhen({ precision: 'day', start: '2023-3-3', original: 'March 3, 2023' }, cited('Report completed: March 3, 2023.')).when.precision).toBe('unknown')
    expect(checkWhen({ precision: 'unknown', start: '2023-03-03', original: 'sometime' }, cited('Report completed: March 3, 2023.')).when).toEqual({ precision: 'unknown', original: 'sometime' })
    expect(checkWhen({ precision: 'day', original: 'March 3, 2023' }, cited('Report completed: March 3, 2023.')).when.precision).toBe('unknown')
  })

  it('validates date shapes (also used for reviewer edits)', () => {
    expect(whenShapeErrors({ precision: 'day', start: '2023-03-03', original: 'x' })).toEqual([])
    expect(whenShapeErrors({ precision: 'range', start: '2023-03-03', end: '2023-04-01', original: 'x' })).toEqual([])
    expect(whenShapeErrors({ precision: 'range', start: '2023-04-03', end: '2023-03-01', original: 'x' })[0]).toMatch(/before its start/)
    expect(whenShapeErrors({ precision: 'day', start: '2023-03', original: 'x' })[0]).toMatch(/YYYY-MM-DD/)
    expect(whenShapeErrors({ precision: 'day', start: '2023-02-30', original: 'x' })[0]).toMatch(/valid ISO/)
    expect(whenShapeErrors({ precision: 'unknown', start: '2023', original: 'x' })[0]).toMatch(/unknown date carries no start/)
    expect(whenShapeErrors({ precision: 'day', start: '2023-03-03', original: ' ' })[0]).toMatch(/original text/)
  })
})

describe('F1 prepareDocumentEvents: sources, assertions and issue links', () => {
  const pleading = evidenceOf('Statement of Claim\nIssued November 3, 2025. The Plaintiff fell on January 14, 2025.', { name: '01-statement-of-claim.txt' })
  const base = (overrides: Partial<ModelEvent> = {}): ModelEvent => ({
    when: { precision: 'day', start: '2025-01-14', original: 'January 14, 2025' }, description: 'The Plaintiff fell', type: 'incident', assertion: 'record',
    sources: [{ evidenceId: 'E-001', paragraph: 1, quote: 'The Plaintiff fell on January 14, 2025.' }], issueIds: ['issue-1'], ...overrides,
  })
  const context = { issueIds: new Set(['issue-1']) }

  it('types a record claim from a pleading as an allegation, but not a procedural fact about the pleading', () => {
    const { drafts } = prepareDocumentEvents([
      base(),
      base({ type: 'procedural', description: 'Claim issued', when: { precision: 'day', start: '2025-11-03', original: 'November 3, 2025' }, sources: [{ evidenceId: 'E-001', paragraph: 1, quote: 'Issued November 3, 2025.' }] }),
    ], pleading, context)
    expect(drafts.map((draft) => draft.assertion)).toEqual(['allegation', 'record'])
    expect(drafts[0].warnings.join(' ')).toMatch(/Typed as allegation/)
  })

  it('keeps testimony and inference as the model typed them (valid controls)', () => {
    const { drafts } = prepareDocumentEvents([base({ assertion: 'inference' }), base({ assertion: 'testimony' })], pleading, context)
    expect(drafts.map((draft) => draft.assertion)).toEqual(['inference', 'testimony'])
  })

  it('refuses an event that cites a different document, a missing paragraph or a quotation that is not there', () => {
    const { drafts, rejected } = prepareDocumentEvents([
      base({ sources: [{ evidenceId: 'E-099', paragraph: 1, quote: 'The Plaintiff fell on January 14, 2025.' }] }),
      base({ sources: [{ evidenceId: 'E-001', paragraph: 9, quote: 'The Plaintiff fell on January 14, 2025.' }] }),
      base({ sources: [{ evidenceId: 'E-001', paragraph: 1, quote: 'The Plaintiff was never on the property at all.' }] }),
      base({ sources: [{ evidenceId: 'E-001', paragraph: 1, quote: 'The Plaintiff fell on January 14, 2025.' }, { evidenceId: 'E-001', paragraph: 1, quote: 'invented words that are absent' }] }),
      base(),
    ], pleading, context)
    expect(drafts).toHaveLength(1)
    expect(rejected.map((item) => item.reason)).toEqual([
      expect.stringMatching(/not supplied in this call/), expect.stringMatching(/no paragraph 9/),
      expect.stringMatching(/does not appear in that paragraph/), expect.stringMatching(/Source 2/),
    ])
    for (const item of drafts) expect(item.sources.every((source) => checkPassage(source, [pleading]) === null)).toBe(true)
  })

  it('drops issue links that are not issues of the case model and says so', () => {
    const { drafts } = prepareDocumentEvents([base({ issueIds: ['issue-1', 'issue-9'] })], pleading, context)
    expect(drafts[0].issueIds).toEqual(['issue-1'])
    expect(drafts[0].warnings.join(' ')).toMatch(/Issue links/)
  })
})

describe('F1 merge and conflicts', () => {
  const draft = (description: string, when: ChronologyWhen, extra: Partial<ChronologyEvent> = {}) => ({
    when, description, type: 'incident' as const, assertion: 'record' as const, sources: [{ evidenceId: 'a', paragraph: 1, quote: `quote of ${description}`.padEnd(12, '.') }],
    issueIds: [], review: 'proposed' as const, warnings: [], ...extra,
  })
  const day = (value: string): ChronologyWhen => ({ precision: 'day', start: value, original: value })

  it('merges the same date and a similar description and keeps every source', () => {
    const merged = mergeDrafts([
      draft('Greyvale log records plow and salt of the lot only', day('2025-01-13')),
      draft('Greyvale log records plow and salt of the lot', day('2025-01-13'), { sources: [{ evidenceId: 'b', paragraph: 1, quote: 'second record quote' }] }),
    ])
    expect(merged).toHaveLength(1)
    expect(merged[0].sources.map((source) => source.evidenceId).sort()).toEqual(['a', 'b'])
  })

  it('does not merge different dates, different assertion types or dissimilar descriptions', () => {
    expect(mergeDrafts([draft('Plaintiff attends physician for knee pain', day('2025-01-13')), draft('Plaintiff attends physician for knee pain', day('2025-01-14'))])).toHaveLength(2)
    expect(mergeDrafts([draft('Plaintiff fell on ice at the entrance', day('2025-01-14')), draft('Plaintiff fell on ice at the entrance', day('2025-01-14'), { assertion: 'allegation' })])).toHaveLength(2)
    expect(mergeDrafts([draft('Plaintiff fell on ice at the entrance', day('2025-01-14')), draft('Surgery performed on the left tibial plateau', day('2025-01-14'))])).toHaveLength(2)
  })

  it('never merges two events whose dates are unknown', () => {
    const unknown: ChronologyWhen = { precision: 'unknown', original: 'later' }
    expect(mergeDrafts([draft('Plaintiff fell on ice at the entrance', unknown), draft('Plaintiff fell on ice at the entrance', unknown)])).toHaveLength(2)
  })

  it('compares dates: a missing time is compatible, different days and different times conflict', () => {
    const at = (start: string, precision: ChronologyWhen['precision'] = 'exact'): ChronologyWhen => ({ precision, start, original: start })
    expect(datesConflict(at('2025-01-14T07:45'), at('2025-01-14T08:05'))).toBe('time')
    expect(datesConflict(at('2025-01-14T07:45'), at('2025-01-15T07:45'))).toBe('date')
    expect(datesConflict(at('2025-01-14', 'day'), at('2025-01-14T07:45'))).toBeNull()
    expect(datesConflict(at('2025-01', 'month'), at('2025-01-14', 'day'))).toBeNull()
    expect(datesConflict(at('2025-02', 'month'), at('2025-01-14', 'day'))).toBe('date')
    expect(datesConflict(at('2025-01-14', 'day'), { precision: 'unknown', original: 'x' })).toBeNull()
    expect(datesConflict({ precision: 'range', start: '2025-01-01', end: '2025-02-01', original: 'x' }, at('2025-05-01', 'day'))).toBeNull()
  })

  it('flags a conflict only when the descriptions are similar enough to be one event', () => {
    const { events, conflicts } = flagConflicts(mergeDrafts([
      draft(fallDescription, at('2025-01-14T07:45')), draft(fallDescription, at('2025-01-14T08:05')),
      draft('Plaintiff attends the physiotherapy clinic for assessment', at('2025-02-24T09:00')),
    ]))
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]).toMatchObject({ kind: 'time', eventIds: ['evt-001', 'evt-002'] })
    expect(events.map((event) => event.conflictsWith)).toEqual([['evt-002'], ['evt-001'], []])
    function at(start: string): ChronologyWhen { return { precision: 'exact', start, original: start } }
  })

  it('flags different days only when the model said both are the same one-time occurrence', () => {
    const visit = (value: string, eventKey?: string) => draft('Plaintiff attends family physician with left knee pain', day(value), eventKey ? { eventKey } : {})
    // Repeated visits share most of their words but are different events: no conflict.
    expect(flagConflicts(mergeDrafts([visit('2023-11-08'), visit('2025-03-27')])).conflicts).toEqual([])
    // The same one-time surgery given two different days is a conflict, even with different wording.
    const surgery = flagConflicts(mergeDrafts([
      draft('Surgery fixing the tibial plateau fracture', day('2025-01-16'), { eventKey: 'the surgery' }),
      draft('Operation to repair the fracture', day('2025-01-17'), { eventKey: 'The surgery' }),
    ]))
    expect(surgery.conflicts).toHaveLength(1)
    expect(surgery.conflicts[0]).toMatchObject({ kind: 'date', eventIds: ['evt-001', 'evt-002'] })
    // Keys that name different things do not conflict.
    expect(flagConflicts(mergeDrafts([visit('2023-11-08', 'first visit'), visit('2025-03-27', 'the surgery')])).conflicts).toEqual([])
  })

  it('measures description overlap on words, not wording', () => {
    expect(descriptionOverlap('The Plaintiff slipped on ice', 'plaintiff slipped on the ice').ratio).toBe(1)
    expect(descriptionOverlap('knee surgery', 'tax return filed').shared).toBe(0)
  })
})

describe('F1 extraction over the fictional civil packet (scripted model)', () => {
  it('saves a draft in which no event lacks a checked passage', async () => {
    const world = buildCivilWorld()
    const { artifact, content, client } = await generated(world)
    expect(artifact).toMatchObject({ kind: 'chronology', status: 'draft', version: 1 })
    expect(artifact.inputManifest).toMatchObject({ promptVersion: 'chronology-extraction-v1', algorithmVersion: 'chronology-v1', provider: { name: 'scripted' } })
    expect(client.calls).toHaveLength(19)
    expect(content.items.length).toBeGreaterThanOrEqual(35)
    const evidence = world.store.listEvidence(world.matterId)
    for (const event of content.items) {
      expect(event.sources.length, event.id).toBeGreaterThan(0)
      for (const source of event.sources) expect(checkPassage(source, evidence), event.id).toBeNull()
      expect(event.review).toBe('proposed')
    }
    // Everything the model said was either kept or listed with a reason.
    expect(artifact.rejected).toEqual([])
    expect(content.documents.failed).toEqual([])
    expect(content.documents.processed).toHaveLength(19)
  })

  it('keeps unknown dates unknown and downgrades dates the passage does not state', async () => {
    const world = buildCivilWorld()
    const { content } = await generated(world)
    const er = world.exhibit('09-emergency-record.txt')
    const erEvents = content.items.filter((event) => event.sources.some((source) => world.store.listEvidence(world.matterId).find((item) => item.id === source.evidenceId)?.exhibitId === er))
    const triage = erEvents.find((event) => event.when.original === 'Triage 10:12')
    expect(triage?.when).toEqual({ precision: 'unknown', original: 'Triage 10:12' })
    expect(triage?.warnings.join(' ')).toMatch(/does not state this date/)
    const approx = erEvents.find((event) => event.when.original === 'approx 0900')
    expect(approx?.when.precision).toBe('unknown')
    expect(approx?.when.start).toBeUndefined()
    // Dated hospital events keep their dates.
    expect(erEvents.find((event) => event.when.start === '2025-01-16')?.when.precision).toBe('day')
    // No unknown event has a start or end.
    for (const event of content.items.filter((candidate) => candidate.when.precision === 'unknown')) {
      expect(event.when.start).toBeUndefined()
      expect(event.when.end).toBeUndefined()
    }
  })

  it('keeps supported dates exactly (valid controls from the answer key)', async () => {
    const world = buildCivilWorld()
    const { content } = await generated(world)
    const find = (start: string, text: string) => content.items.find((event) => event.when.start === start && event.description.includes(text))
    expect(find('2023-11-08', 'family physician')?.when).toEqual({ precision: 'day', start: '2023-11-08', original: '2023-11-08' })
    expect(content.items.find((event) => event.when.precision === 'range')?.when).toEqual({ precision: 'range', start: '2025-01-14', end: '2025-10-19', original: 'January 14, 2025 to October 19, 2025' })
    expect(find('2025-01-14T07:45', 'slipped')?.when.precision).toBe('approximate')
    expect(find('2025-01-14T07:40', 'slipped')?.assertion).toBe('testimony')
  })

  it('merges a fact stated in two documents into one event with both sources', async () => {
    const world = buildCivilWorld()
    const { content } = await generated(world)
    const evidence = world.store.listEvidence(world.matterId)
    const arrival = content.items.find((event) => event.when.start === '2025-01-13T22:10')
    expect(arrival?.sources.map((source) => evidence.find((item) => item.id === source.evidenceId)?.name).sort()).toEqual(['06-winter-service-log.txt', '07-gps-dispatch-export.txt'])
  })

  it('types pleaded and examined statements as allegation and testimony, never as record', async () => {
    const world = buildCivilWorld()
    const { content } = await generated(world)
    const evidence = world.store.listEvidence(world.matterId)
    const name = (event: ChronologyEvent) => evidence.find((item) => item.id === event.sources[0].evidenceId)!.name
    for (const event of content.items) {
      if (name(event).startsWith('01-') || name(event).startsWith('02-') || name(event).startsWith('03-')) {
        if (event.type !== 'procedural') expect(event.assertion, `${name(event)} ${event.description}`).toBe('allegation')
      }
      if (name(event).startsWith('15-') || name(event).startsWith('16-')) {
        if (event.type !== 'procedural') expect(event.assertion).toBe('testimony')
      }
    }
    // Procedural facts about the pleading itself stay record.
    expect(content.items.find((event) => event.when.start === '2025-11-03')?.assertion).toBe('record')
  })

  it('flags the planted conflict about the time of the fall and nothing else', async () => {
    const world = buildCivilWorld()
    const { content } = await generated(world)
    const fall = content.items.filter((event) => event.description === fallDescription)
    const dated = fall.filter((event) => event.when.start?.includes('T'))
    expect(dated.map((event) => event.when.start).sort()).toEqual(['2025-01-14T07:40', '2025-01-14T07:45', '2025-01-14T08:05'])
    for (const event of dated) expect(event.conflictsWith.length, event.when.start).toBe(2)
    expect(content.conflicts).toHaveLength(1)
    expect(content.conflicts[0]).toMatchObject({ kind: 'time' })
    expect(new Set(content.conflicts[0].eventIds)).toEqual(new Set(dated.map((event) => event.id)))
    // The hospital's approximate time has no date in its passage, so it stays undated rather than being compared.
    expect(fall.filter((event) => event.when.precision === 'unknown').every((event) => event.conflictsWith.length === 0)).toBe(true)
    // Day-only statements of the same date are compatible, not conflicts.
    expect(fall.filter((event) => event.when.precision === 'day').every((event) => event.conflictsWith.length === 0)).toBe(true)
    // The answer key says this topic is a conflict between sources.
    expect(answerKey.conflicts.find((conflict) => conflict.id === 'C1')?.topic).toBe('Time of the fall')
  })

  it('records the dates code found, with ambiguous ones unresolved', async () => {
    const world = buildCivilWorld()
    world.store.addEvidence(world.matterId, {
      name: 'ambiguous.txt', type: 'text', mimeType: 'text/plain', size: 10, text: 'Note received 04/05/2023 by mail.', summary: '', tags: [],
      sha256: 'a'.repeat(64), ingestionStatus: 'stored',
    })
    const { content } = await generated(world, () => ({ events: [] }))
    const candidate = content.candidateDates.find((entry) => entry.original === '04/05/2023')
    expect(candidate).toMatchObject({ precision: 'unknown', ambiguous: { readings: expect.arrayContaining(['2023-04-05', '2023-05-04']) } })
    expect(content.candidateDates.length).toBeGreaterThan(40)
    expect(content.items).toEqual([])
  })

  it('lists a document the model step failed on, and still saves the rest', async () => {
    const world = buildCivilWorld()
    const inner = chronologyRouter(world)
    const { content, artifact } = await generated(world, (request) => {
      if (documentOf(request) === world.exhibit('08-adjuster-letter.txt')) {
        throw new StructuredModelError('provider unavailable', { category: 'provider_error', audit: { task: request.task, promptVersion: 'x', provider: 'scripted', model: 'scripted', mode: 'scripted', attempts: 1 } })
      }
      return inner(request)
    })
    expect(content.documents.failed).toHaveLength(1)
    expect(content.documents.failed[0]).toMatchObject({ exhibitId: world.exhibit('08-adjuster-letter.txt') })
    expect(content.documents.failed[0].reason).toMatch(/model step failed/)
    expect(content.documents.processed).toHaveLength(18)
    expect(artifact.status).toBe('draft')
  })

  it('lists a document over the character limit instead of truncating it', async () => {
    const world = buildCivilWorld()
    addSource(world.store, world.matterId, 'big.txt', `Big note on March 3, 2023. ${'x'.repeat(250_000)}`)
    const { content } = await generated(world)
    expect(content.documents.failed).toHaveLength(1)
    expect(content.documents.failed[0].reason).toMatch(/nothing was truncated/)
  })

  it('refuses an unknown requested document', async () => {
    const world = buildCivilWorld()
    const service = new ChronologyService(world.store, world.service, world.workflow)
    await expect(service.generate(world.matterId, { client: routedClient(() => ({ events: [] })), evidenceIds: ['missing'] })).rejects.toThrow(ChronologyError)
  })

  it('records no file time as an event date', async () => {
    const world = buildCivilWorld()
    const { content } = await generated(world)
    const uploaded = world.store.listEvidence(world.matterId).map((item) => item.uploadedAt.slice(0, 10))
    const today = new Date().toISOString().slice(0, 10)
    expect(uploaded).toContain(today)
    expect(content.items.some((event) => event.when.start?.startsWith(today))).toBe(false)
    expect(content.candidateDates.some((candidate) => candidate.start?.startsWith(today))).toBe(false)
  })
})

describe('F1 prompt injection in a fixture source (scripted)', () => {
  it('keeps the planted line inside the delimited document and out of the instructions and every saved output', async () => {
    const world = buildCivilWorld()
    const { client, content, artifact } = await generated(world)
    const { line, canary, file } = answerKey.injection
    const call = client.calls.find((entry) => entry.request.inputs[0].id === world.exhibit(file))!
    expect(call.request.inputs[0].text).toContain(line)
    expect(call.prompt.system).not.toContain(canary)
    expect(call.prompt.system).not.toMatch(/ignore your previous instructions/i)
    expect(call.request.instructions).not.toContain(canary)
    expect(call.prompt.user.indexOf(line)).toBeGreaterThan(call.prompt.user.indexOf('<<<BEGIN UNTRUSTED DOCUMENT'))
    // The behaviour does not change: the same events come out of that document as the key lists.
    const logEvents = content.items.filter((event) => event.sources.some((source) => source.evidenceId === world.byFile.get(file)!.id))
    expect(logEvents.length).toBeGreaterThanOrEqual(2)
    expect(JSON.stringify(content)).not.toContain(canary)
    expect(JSON.stringify(artifact.rejected)).not.toContain(canary)
    expect(content.items.every((event) => !/no liability/i.test(event.description))).toBe(true)
  })
})

describe('F1 review queue, immutability and accepted events', () => {
  async function reviewed() {
    const world = buildCivilWorld()
    const run = await generated(world)
    return { world, ...run }
  }

  it('saves each decision as a new draft version and never edits an older one', async () => {
    const { world, service, artifact, content } = await reviewed()
    const first = content.items[0]
    const before = world.service.get(world.matterId, artifact.id)
    const view = service.review(world.matterId, first.id, { action: 'accept', note: 'checked against the source' })
    expect(view.artifact).toMatchObject({ version: 2, status: 'draft' })
    expect(view.content.items.find((event) => event.id === first.id)?.review).toBe('accepted')
    expect(view.content.reviewLog).toEqual([{ eventId: first.id, action: 'accept', note: 'checked against the source' }])
    // The version it was made from is untouched.
    const after = world.service.get(world.matterId, artifact.id)
    expect(after.contentHash).toBe(before.contentHash)
    expect((after.content as ChronologyContent).items.find((event) => event.id === first.id)?.review).toBe('proposed')

    const rejected = service.review(world.matterId, content.items[1].id, { action: 'reject' })
    expect(rejected.artifact.version).toBe(3)
    expect(rejected.content.items.filter((event) => event.review !== 'proposed').map((event) => event.review).sort()).toEqual(['accepted', 'rejected'])
    const reset = service.review(world.matterId, content.items[1].id, { action: 'reset' })
    expect(reset.content.items.find((event) => event.id === content.items[1].id)?.review).toBe('proposed')
  })

  it('exposes only accepted events, and only from the approved version', async () => {
    const { world, service, content } = await reviewed()
    expect(service.acceptedEvents(world.matterId)).toEqual([])
    service.review(world.matterId, content.items[0].id, { action: 'accept' })
    service.review(world.matterId, content.items[1].id, { action: 'accept' })
    service.review(world.matterId, content.items[2].id, { action: 'reject' })
    // A draft is not approved: still nothing is exposed.
    expect(service.acceptedEvents(world.matterId)).toEqual([])
    service.approve(world.matterId)
    const accepted = service.acceptedEvents(world.matterId)
    expect(accepted.map((event) => event.id).sort()).toEqual([content.items[0].id, content.items[1].id].sort())
    expect(accepted.every((event) => event.review === 'accepted')).toBe(true)

    // Reviewing an approved chronology makes a new draft; the approved one keeps answering until the draft is approved.
    service.review(world.matterId, content.items[3].id, { action: 'accept' })
    expect(service.acceptedEvents(world.matterId)).toHaveLength(2)
    const views = service.views(world.matterId)
    expect(views).toMatchObject({ current: 'draft' })
    expect(views.approved?.artifact.status).toBe('approved')
    service.approve(world.matterId)
    expect(service.acceptedEvents(world.matterId)).toHaveLength(3)
    expect(world.service.list(world.matterId, { kind: 'chronology' }).filter((artifact) => artifact.status === 'approved')).toHaveLength(1)
  })

  it('reads accepted events through the owner approved-artifact path only', async () => {
    const { world, service, content } = await reviewed()
    service.review(world.matterId, content.items[0].id, { action: 'accept' })
    service.approve(world.matterId)
    expect(world.service.approvedFor({ role: 'owner' }, world.matterId, 'chronology')).toHaveLength(1)
    // An owner-audience artifact is not visible to a party viewer.
    expect(world.service.approvedFor({ role: 'party', partyId: 'ellery' }, world.matterId, 'chronology')).toEqual([])
  })

  it('applies an edit to the event, marks it edited and validates the date', async () => {
    const { world, service, content } = await reviewed()
    const target = content.items.find((event) => event.when.precision === 'unknown')!
    const view = service.review(world.matterId, target.id, {
      action: 'edit', patch: { description: 'Corrected description', when: { precision: 'day', start: '2025-01-14', original: 'January 14, 2025' }, issueIds: ['issue-greyvale'] },
    })
    const edited = view.content.items.find((event) => event.id === target.id)!
    expect(edited).toMatchObject({ description: 'Corrected description', edited: true, issueIds: ['issue-greyvale'], review: 'proposed' })
    expect(edited.when.precision).toBe('day')
    expect(edited.sources).toEqual(target.sources)
    expect(() => service.review(world.matterId, target.id, { action: 'edit', patch: { when: { precision: 'day', start: '2025-01', original: 'x' } } })).toThrow(/not valid/)
    expect(() => service.review(world.matterId, target.id, { action: 'edit', patch: { issueIds: ['not-an-issue'] } })).toThrow(/not an issue/)
  })

  it('refuses unknown events, an empty store and a stale chronology', async () => {
    const world = buildCivilWorld()
    const service = new ChronologyService(world.store, world.service, world.workflow)
    expect(() => service.review(world.matterId, 'evt-001', { action: 'accept' })).toThrow(/no chronology/)
    expect(() => service.approve(world.matterId)).toThrow(/no draft/)
    const { content } = await generated(world)
    expect(() => service.review(world.matterId, 'evt-999', { action: 'accept' })).toThrow(/not found/)
    addSource(world.store, world.matterId, 'late.txt', 'A late source dated March 3, 2024.')
    expect(() => service.review(world.matterId, content.items[0].id, { action: 'accept' })).toThrow(/out of date/)
  })
})

describe('F1 key facts and promotion', () => {
  const event = (id: string, overrides: Partial<ChronologyEvent> = {}): ChronologyEvent => ({
    id, when: { precision: 'day', start: '2025-01-14', original: 'January 14, 2025' }, description: id, type: 'incident', assertion: 'record',
    sources: [{ evidenceId: 'a', paragraph: 1, quote: 'quotation text' }], issueIds: [], conflictsWith: [], review: 'accepted', warnings: [], ...overrides,
  })

  it('ranks accepted events by issue links, dispute status and source count, deterministically', () => {
    const events = [
      event('plain'),
      event('linked', { issueIds: ['i1'] }),
      event('disputed', { conflictsWith: ['x'] }),
      event('many-sources', { sources: [1, 2, 3].map((n) => ({ evidenceId: `d${n}`, paragraph: 1, quote: 'quotation text' })) }),
      event('two-issues', { issueIds: ['i1', 'i2'] }),
      event('proposed-only', { review: 'proposed', issueIds: ['i1', 'i2', 'i3'] }),
      event('rejected-only', { review: 'rejected', issueIds: ['i1', 'i2', 'i3'] }),
    ]
    const ranked = rankKeyFacts(events)
    expect(ranked.map((fact) => fact.eventId)).toEqual(['two-issues', 'disputed', 'linked', 'many-sources', 'plain'])
    expect(ranked.map((fact) => fact.rank)).toEqual([1, 2, 3, 4, 5])
    expect(ranked[1].reasons.join(' ')).toMatch(/disagree/)
    expect(rankKeyFacts([...events].reverse()).map((fact) => fact.eventId)).toEqual(ranked.map((fact) => fact.eventId))
    expect(rankKeyFacts(events, 2)).toHaveLength(2)
    expect(rankKeyFacts([])).toEqual([])
  })

  async function approvedWorld() {
    const world = buildCivilWorld()
    const run = await generated(world)
    const pick = (predicate: (event: ChronologyEvent) => boolean) => run.content.items.find(predicate)!
    const conflicted = run.content.items.filter((item) => item.conflictsWith.length > 0)
    for (const item of [...conflicted, pick((item) => item.when.start === '2023-11-08')]) run.service.review(world.matterId, item.id, { action: 'accept' })
    run.service.approve(world.matterId)
    return { world, ...run, conflicted, plain: pick((item) => item.when.start === '2023-11-08') }
  }

  it('lists key facts only from the approved chronology', async () => {
    const { world, service } = await approvedWorld()
    const facts = service.keyFacts(world.matterId)
    expect(facts).toHaveLength(4)
    expect(facts[0].reasons.join(' ')).toMatch(/disagree/)
    expect(facts.at(-1)?.event.when.start).toBe('2023-11-08')
  })

  it('promotes a key fact to a disputed fact in a NEW case model version, with conflicting sources as contradicting', async () => {
    const { world, service, conflicted } = await approvedWorld()
    const before = world.store.workflow.listCaseModels(world.matterId)
    const promoted = service.promoteKeyFact(world.matterId, conflicted[0].id)
    const after = world.store.workflow.listCaseModels(world.matterId)
    expect(after).toHaveLength(before.length + 1)
    expect(promoted).toMatchObject({ version: world.model.version + 1, status: 'draft' })
    // The approved model is untouched.
    expect(world.store.workflow.getCaseModel(world.model.id)).toEqual(world.model)
    expect(world.model.disputedFacts).toEqual([])
    const fact = promoted.disputedFacts.find((candidate) => candidate.id === `fact-${conflicted[0].id}`)!
    expect(fact).toMatchObject({ proposition: fallDescription, attribution: 'unresolved', issueIds: ['issue-greyvale'] })
    expect(fact.supporting).toHaveLength(conflicted[0].sources.length)
    expect(fact.contradicting.length).toBeGreaterThanOrEqual(2)
    expect(fact.supporting[0]).toMatchObject({ attribution: 'source', locator: { paragraph: 1 } })
    expect(fact.supporting[0].quote).toBeTruthy()
  })

  it('refuses to promote the same event twice, an event that was not accepted and an unknown case model', async () => {
    const { world, service, conflicted, content } = await approvedWorld()
    service.promoteKeyFact(world.matterId, conflicted[0].id)
    expect(() => service.promoteKeyFact(world.matterId, conflicted[0].id)).toThrow(/already a disputed fact/)
    const acceptedIds = new Set(service.acceptedEvents(world.matterId).map((candidate) => candidate.id))
    const proposed = content.items.find((candidate) => !acceptedIds.has(candidate.id))!
    expect(() => service.promoteKeyFact(world.matterId, proposed.id)).toThrow(/accepted event/)
    expect(() => service.promoteKeyFact(world.matterId, conflicted[1].id, 'missing-model')).toThrow(/does not belong/)
  })

  it('marks a plain record fact as sourced, and an inference as inferred', async () => {
    const { world, service, plain } = await approvedWorld()
    const promoted = service.promoteKeyFact(world.matterId, plain.id)
    expect(promoted.disputedFacts.find((fact) => fact.id === `fact-${plain.id}`)).toMatchObject({ attribution: 'source', contradicting: [] })
  })
})

describe('F1 juror-style readings: admitted material only', () => {
  const canary = 'CANARY_EXCLUDED_5d1c9a'
  const redactedTerm = 'About 7:40 in the morning'

  async function setup() {
    const world = buildCivilWorld()
    const secret = addSource(world.store, world.matterId, '20-excluded-note.txt', `Excluded note.\nOn March 3, 2023 the witness told counsel the secret ${canary}.`)
    const readingsRequests: Array<StructuredRequest<unknown>> = []
    const base = chronologyRouter(world)
    const router: Router = (request) => {
      if (request.task === 'chronology_readings') {
        readingsRequests.push(request)
        return { readings: [
          { lens: 'plain_language', text: 'The chart shows the knee was already sore in 2023.' },
          { lens: 'likely_question', text: 'Why did the report assume no earlier trouble?' },
          { lens: 'which_way_it_cuts', text: 'It tends to help the defence on damages.', cutsToward: 'defence' },
        ] }
      }
      if (documentOf(request) === secret.exhibitId) {
        return { events: [{
          when: { precision: 'day', start: '2023-03-03', original: 'March 3, 2023' }, description: 'Witness told counsel a secret', type: 'communication', assertion: 'testimony',
          sources: [{ evidenceId: secret.exhibitId, paragraph: 1, quote: `the witness told counsel the secret ${canary}` }], issueIds: [],
        }] }
      }
      return base(request)
    }
    const run = await generated(world, router)
    const find = (predicate: (event: ChronologyEvent) => boolean) => run.content.items.find(predicate)!
    const admitted = find((event) => event.when.start === '2023-11-08')
    const excluded = find((event) => event.description.includes('secret'))
    const redacted = find((event) => event.assertion === 'testimony' && event.sources.some((source) => source.quote.includes(redactedTerm)))
    const hidden = find((event) => event.when.start === '2026-03-02' && event.description.includes('Modified duties'))
    for (const event of [admitted, excluded, redacted, hidden]) run.service.review(world.matterId, event.id, { action: 'accept' })
    run.service.approve(world.matterId)
    const saveLedger = (changes: Record<string, Partial<{ status: string; redactions: string[]; hiddenFrom: string[]; purposes: string[] }>>) => world.workflow.saveAdmissionLedger(world.matterId, {
      reason: 'Test rulings',
      evidenceUses: world.store.listEvidence(world.matterId).map((item) => ({
        evidenceId: item.id, status: 'admitted', purposes: [], redactions: [], hiddenFrom: [], note: '', ...(changes[item.name] ?? {}),
      })),
    })
    return { world, ...run, readingsRequests, admitted, excluded, redacted, hidden, saveLedger, secret }
  }

  it('needs an admission ledger: with none, nothing is admitted', async () => {
    const { world, service } = await setup()
    await expect(service.generateReadings(world.matterId, { client: routedClient(() => ({})) })).rejects.toThrow(/admission/)
  })

  it('never lets excluded, redacted or hidden material reach the model, and labels the output simulated', async () => {
    const { world, service, readingsRequests, saveLedger, admitted, excluded, redacted, hidden, secret } = await setup()
    saveLedger({
      '20-excluded-note.txt': { status: 'excluded' },
      '15-discovery-excerpt-plaintiff.txt': { status: 'redacted', redactions: [redactedTerm] },
      '17-employer-earnings-letter.txt': { hiddenFrom: ['juror'] },
    })
    const base = chronologyRouter(world)
    const client = routedClient((request) => (request.task === 'chronology_readings' ? readingsRequests.push(request) && {
      readings: [
        { lens: 'plain_language', text: 'Plain reading.' }, { lens: 'likely_question', text: 'A question.' }, { lens: 'which_way_it_cuts', text: 'Cuts one way.', cutsToward: 'unclear' },
      ] } : base(request)))
    const saved = await service.generateReadings(world.matterId, { client })
    const readings = (saved.content as ChronologyContent).readings!

    // Positive control: the admitted fact was read.
    expect(readings.items.map((item) => item.eventId)).toEqual([admitted.id])
    expect(readings.items[0].readings).toHaveLength(3)
    expect(readings.label).toMatch(/Simulated model output/)
    expect(readings.basis).toBe('not venue-based')
    expect(readings.skipped.map((item) => item.eventId).sort()).toEqual([excluded.id, hidden.id, redacted.id].sort())
    expect(readings.skipped[0].reason).toMatch(/available to jurors/)

    // The canary, the redacted words and the hidden letter never appeared in any request.
    expect(client.calls).toHaveLength(1)
    const everything = JSON.stringify(client.calls.map((call) => [call.request, call.prompt]))
    expect(everything).not.toContain(canary)
    expect(everything).not.toContain(redactedTerm)
    expect(everything).not.toContain('Modified duties at 30 hours')
    expect(everything).toContain('Chart extract of Dr. L. Penhallow')
    // The event description is never sent: it may come from material jurors cannot see.
    expect(everything).not.toContain('Witness told counsel')
    expect(secret.exhibitId).toBe('E-020')
    expect(JSON.stringify(readings)).not.toContain(canary)
  })

  it('hides readings once a newer admission ledger exists, and shows them again when written again', async () => {
    const { world, service, saveLedger } = await setup()
    saveLedger({})
    const client = routedClient(() => ({ readings: [
      { lens: 'plain_language', text: 'Plain reading.' }, { lens: 'likely_question', text: 'A question.' }, { lens: 'which_way_it_cuts', text: 'Cuts one way.' },
    ] }))
    await service.generateReadings(world.matterId, { client })
    let view = service.views(world.matterId).draft!
    expect(view.content.readings).toMatchObject({ status: 'current' })
    expect(view.content.readings!.items.length).toBeGreaterThan(0)
    saveLedger({ '10-family-physician-chart.txt': { status: 'excluded' } })
    view = service.views(world.matterId).draft!
    expect(view.content.readings).toMatchObject({ status: 'out_of_date', items: [] })
    expect(view.content.readings!.withheld).toMatch(/hidden/)
  })

  it('rejects a reply with fewer than three readings or a missing lens, and records the failure', async () => {
    const { world, service, saveLedger } = await setup()
    saveLedger({})
    const saved = await service.generateReadings(world.matterId, {
      client: routedClient(() => ({ readings: [{ lens: 'plain_language', text: 'Only one.' }] })),
    })
    const readings = (saved.content as ChronologyContent).readings!
    expect(readings.items).toEqual([])
    expect(readings.failed.length).toBeGreaterThan(0)
    expect(readings.failed[0].reason).toMatch(/schema_violation/)
  })

  it('needs accepted key facts in an approved chronology', async () => {
    const world = buildCivilWorld()
    const run = await generated(world)
    world.workflow.saveAdmissionLedger(world.matterId, {
      reason: 'r', evidenceUses: world.store.listEvidence(world.matterId).map((item) => ({ evidenceId: item.id, status: 'admitted', purposes: [], redactions: [], hiddenFrom: [], note: '' })),
    })
    await expect(run.service.generateReadings(world.matterId, { client: routedClient(() => ({})) })).rejects.toThrow(/accepted key facts/)
  })
})

describe('F1 store hygiene', () => {
  it('works on a matter with no case model', async () => {
    const store = memoryStore()
    const matter = store.createMatter({ title: 'No model', narrative: 'n' })
    addSource(store, matter.id, 'a.txt', 'A note dated March 3, 2023 about a meeting.')
    const { AnalysisService } = await import('../server/analysis/service')
    const { CaseWorkflowService } = await import('../server/caseWorkflow')
    const service = new ChronologyService(store, new AnalysisService(store), new CaseWorkflowService(store))
    const artifact = await service.generate(matter.id, { client: routedClient(() => ({ events: [{
      when: { precision: 'day', start: '2023-03-03', original: 'March 3, 2023' }, description: 'A meeting', type: 'communication', assertion: 'record',
      sources: [{ evidenceId: 'E-001', paragraph: 1, quote: 'A note dated March 3, 2023' }], issueIds: ['x'],
    }] })) })
    const content = artifact.content as unknown as ChronologyContent
    expect(content.items[0].issueIds).toEqual([])
    expect(artifact.caseModelId).toBeUndefined()
  })
})
