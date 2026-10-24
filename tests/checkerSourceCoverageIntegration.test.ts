import { describe, expect, it } from 'vitest'
import { groundingUnits, parseGroundingReview, type GroundingUnit } from '../server/grounding'
import { MiniMaxClient, type StageRequest } from '../server/minimax'
import type { EvidenceItem, StageResult } from '../server/types'
import { supportedOpeningSource } from '../samples/courtroom-realism/supported-opening'

const omitted = 'OMITTED_UNIQUE_PARAGRAPH_THREE'
const texts = [
  'CURRENT_ONE: Mira states that Rowan approached the desk.',
  'CURRENT_TWO: Mira states that Rowan carried a sealed envelope.',
  `${omitted}: Mira states that Rowan told Ellis the token was blue.`,
  'CURRENT_FOUR: Mira states that the hallway was quiet.',
  'CURRENT_FIVE: Mira states that Rowan approached the desk carrying a sealed envelope and told Ellis the token was blue.',
]
const evidence: EvidenceItem[] = [{ ...supportedOpeningSource, id: 'fictional-coverage-source', exhibitId: 'E-001', name: 'Fictional source',
  text: texts.join('\n\n'), summary: '', authorizedPassages: texts.map((text, index) => ({ paragraph: index + 1, text, startOffset: index * 100, endOffset: index * 100 + text.length })) }]
const claim = 'Mira’s account describes Rowan approaching the desk, carrying a sealed envelope, and telling Ellis that the token was blue (E-001).'
const draft: StageResult = { title: 'OTHER_TITLE_UNIT', content: claim, citations: ['E-001'], jurors: [] }
const request: StageRequest = { stage: 'crown_closing', packet: 'Fictional coverage exercise.', previousTurns: '', evidence }
type Body = { messages: Array<{ role: string; content: string }> }
type Row = { status: string; supportTypes: unknown; explanation: string; citations: Array<{ exhibitId: string; paragraph: number }>; recordCitations: Array<{ eventId: string }> }
const analysis: Row = { status: 'analysis', supportTypes: ['analysis'], explanation: 'A neutral current heading or assessment.', citations: [], recordCitations: [] }
function finding(paragraphs: number[], status = 'supported'): Row {
  return { status, supportTypes: ['source'], explanation: status === 'unsupported' ? 'The current selected passages do not support the token-colour clause.' : 'The selected account passages support every clause.', citations: paragraphs.map(paragraph => ({ exhibitId: 'E-001', paragraph })), recordCitations: [] }
}
const inventory = (body: Body): GroundingUnit[] => JSON.parse(body.messages[1].content.split('Draft units to check:\n')[1])
function rows(units: GroundingUnit[], source: Row, invalidSibling = false) {
  return { findings: Object.fromEntries(units.map(unit => [unit.id, unit.id === 'content:1' ? source : { ...analysis, ...(invalidSibling && unit.id === 'title:1' ? { supportTypes: [] } : {}) }])) }
}
function prior(paragraphs = [1, 2, 3], priorDraft = draft, q = request) {
  const units = groundingUnits(priorDraft)
  const review = parseGroundingReview(JSON.stringify(rows(units, finding(paragraphs))), units, q.evidence, q.groundingContext ?? '')
  expect(review.status).toBe('passed')
  return review
}
function harness(replies: Array<(units: GroundingUnit[], body: Body) => unknown>, maxRetries = 2) {
  const bodies: Body[] = []
  const client = new MiniMaxClient({ provider: 'minimax', apiKey: 'fictional', baseUrl: 'https://fixture.invalid/v1', model: 'fictional', timeoutMs: 1000, maxRetries }, undefined, async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as Body
    bodies.push(body)
    if (!replies[bodies.length - 1]) throw new Error('Unexpected extra mocked checker call.')
    return Response.json({ choices: [{ message: { content: JSON.stringify(replies[bodies.length - 1](inventory(body), body)) } }] })
  })
  return { client, bodies }
}
const reply = (paragraphs: number[], invalidSibling = false, status = 'supported') => (units: GroundingUnit[]) => rows(units, finding(paragraphs, status), invalidSibling)
function assertFocus(body: Body, paragraphs: number[]) {
  expect(inventory(body)).toEqual([{ id: 'content:1', text: claim }])
  const sourceText = body.messages[1].content.split('Permitted source record:\n')[1].split('\n\nResponse contract:')[0]
  expect([...sourceText.matchAll(/\[E-001 paragraph (\d+)\]/g)].map(match => Number(match[1]))).toEqual(paragraphs)
  expect(JSON.stringify(body)).not.toContain(omitted)
  expect(JSON.stringify(body)).not.toContain('OTHER_TITLE_UNIT')
}

describe('checker source selection coverage is independently reviewed within the existing retry cap', () => {
  it('retains a valid source anchor beside a sibling metadata failure and holds a narrowed unsupported selection', async () => {
    const h = harness([reply([1, 2, 3], true), reply([1, 2, 4]), reply([1, 2, 4], false, 'unsupported')])
    const review = await h.client.reviewGrounding(request, draft)
    expect(h.bodies).toHaveLength(3)
    assertFocus(h.bodies[2], [1, 2, 4])
    expect(review.status).toBe('failed')
    expect(review.findings.find(row => row.unitId === 'content:1')?.status).toBe('unsupported')
    expect(review.verificationFailures?.[0].findings?.find(row => row.unitId === 'content:1')?.citations.map(c => c.paragraph)).toEqual([1, 2, 3])
    expect(review.errors.join(' ')).toContain('coverage')
  })

  it('accepts a genuinely complete alternative after a focused whole-unit check', async () => {
    const h = harness([reply([5]), reply([5])])
    const review = await h.client.reviewGrounding(request, draft, prior())
    expect(h.bodies).toHaveLength(2)
    assertFocus(h.bodies[1], [5])
    expect(review.errors).toEqual([])
    expect(review.status).toBe('passed')
    expect(review.findings.find(row => row.unitId === 'content:1')?.citations.map(c => c.paragraph)).toEqual([5])
  })

  it('can correct an earlier false acceptance without permanently locking its source selection', async () => {
    const h = harness([reply([5]), reply([5])])
    const review = await h.client.reviewGrounding(request, draft, prior([1, 2, 4]))
    expect(h.bodies).toHaveLength(2)
    expect(review.errors).toEqual([])
    expect(review.status).toBe('passed')
    expect(review.findings.find(row => row.unitId === 'content:1')?.citations.map(c => c.paragraph)).toEqual([5])
  })

  it('does not bind an earlier unit text to a newly repaired source statement', async () => {
    const changed = { ...draft, content: 'Mira’s account describes Rowan approaching the desk while carrying a sealed envelope (E-001).' }
    const h = harness([reply([1, 2])])
    const review = await h.client.reviewGrounding(request, changed, prior())
    expect(h.bodies).toHaveLength(1)
    expect(review.status).toBe('passed')
  })

  it('does not spend a call on reordered complete selectors', async () => {
    const h = harness([reply([3, 1, 2])])
    expect((await h.client.reviewGrounding(request, draft, prior())).status).toBe('passed')
    expect(h.bodies).toHaveLength(1)
  })

  it('withholds a lost selection when the caller disables the focus budget', async () => {
    const h = harness([reply([1, 2, 4])], 0)
    const review = await h.client.reviewGrounding(request, draft, prior())
    expect(h.bodies).toHaveLength(1)
    expect(review.status).toBe('failed')
    expect(review.errors.join(' ')).toContain('coverage')
  })

  it('withholds after a metadata retry exhausts the focus budget', async () => {
    const h = harness([reply([1, 2, 3], true), reply([1, 2, 4])], 1)
    const review = await h.client.reviewGrounding(request, draft)
    expect(h.bodies).toHaveLength(2)
    expect(review.status).toBe('failed')
    expect(review.errors.join(' ')).toContain('coverage')
  })

  it('does not hide source loss by changing supported to analysis and dropping every selector', async () => {
    const h = harness([reply([], false, 'analysis')], 0)
    const review = await h.client.reviewGrounding(request, draft, prior())
    expect(h.bodies).toHaveLength(1)
    expect(review.status).toBe('failed')
    expect(review.errors.join(' ')).toContain('coverage')
  })

  it('checks two independently narrowed units separately within the same total cap', async () => {
    const secondClaim = 'Mira’s account describes Rowan telling Ellis that the token was blue (E-001).'
    const current = { ...draft, content: `${claim} ${secondClaim}` }
    const complete = (units: GroundingUnit[], paragraphs: number[]) => ({ findings: Object.fromEntries(units.map(unit => [unit.id, unit.id.startsWith('content:') ? finding(paragraphs) : analysis])) })
    const units = groundingUnits(current)
    const previous = parseGroundingReview(JSON.stringify(complete(units, [1, 2, 3])), units, evidence)
    expect(previous.status).toBe('passed')
    const h = harness([checked => complete(checked, [5]), checked => complete(checked, [5]), checked => complete(checked, [5])])
    const review = await h.client.reviewGrounding(request, current, previous)
    expect(h.bodies).toHaveLength(3)
    expect(inventory(h.bodies[1])).toEqual([{ id: 'content:1', text: claim }])
    expect(inventory(h.bodies[2])).toEqual([{ id: 'content:2', text: secondClaim }])
    expect(review.errors).toEqual([])
    expect(review.status).toBe('passed')
  })

  it('retains pending coverage after a malformed focus across a later whole-draft review', async () => {
    const first = harness([reply([1, 2, 4]), units => ({ findings: { [units[0].id]: { ...finding([1, 2, 4]), supportTypes: null } } })])
    const incomplete = await first.client.reviewGrounding(request, draft, prior())
    expect(first.bodies).toHaveLength(2)
    expect(incomplete.status).toBe('failed')
    const next = harness([reply([1, 2, 4])], 0)
    const review = await next.client.reviewGrounding(request, draft, incomplete)
    expect(next.bodies).toHaveLength(1)
    expect(review.status).toBe('failed')
    expect(review.errors.join(' ')).toContain('coverage')
  })

  it.each(['supportTypes', 'recordCitations'] as const)('does not manufacture absent legacy %s while composing a focused review', async field => {
    const h = harness([units => ({ findings: units.map(unit => {
      const row: Partial<Row> = { ...(unit.id === 'content:1' ? finding([1, 2, 4]) : analysis) }
      if (unit.id === 'content:1') delete row[field]
      return { unitId: unit.id, ...row }
    }) })])
    const review = await h.client.reviewGrounding(request, draft, prior())
    expect(h.bodies).toHaveLength(1)
    expect(review.status).toBe('failed')
    expect(review.errors.join(' ')).toContain('incomplete finding metadata')
    expect(review.findings.find(row => row.unitId === 'content:1')?.[field]).toBeUndefined()
  })

  it.each(['missing-fields', 'extra-unit', 'omitted-paragraph', 'unknown-exhibit', 'record-reference'] as const)('keeps a malformed or out-of-scope focused response withheld: %s', mode => {
    const q: StageRequest = { ...request, courtroomEvents: [{ eventId: 'outside-focus-record', type: 'public_submission', actorId: 'crown', payload: { text: 'The full account includes the token-colour clause.' } }] }
    const h = harness([reply([1, 2, 4]), units => {
      const row: Partial<Row> = finding([1, 2, 4])
      if (mode === 'missing-fields') delete row.supportTypes
      if (mode === 'omitted-paragraph') row.citations = [{ exhibitId: 'E-001', paragraph: 3 }]
      if (mode === 'unknown-exhibit') row.citations = [{ exhibitId: 'E-999', paragraph: 1 }]
      if (mode === 'record-reference') row.recordCitations = [{ eventId: 'outside-focus-record' }]
      return { findings: { [units[0].id]: row, ...(mode === 'extra-unit' ? { 'content:999': analysis } : {}) } }
    }])
    return h.client.reviewGrounding(q, draft, prior()).then(review => {
      expect(h.bodies).toHaveLength(2)
      expect(review.status).toBe('failed')
    })
  })

  it('sends only the current unit and current passages, with no omitted-source side channels', async () => {
    const q: StageRequest = { ...request, stage: 'juror_ballot', courtroomProtocol: true, proceedingPhase: `${omitted}_PHASE`,
      courtroomActor: { id: 'juror-01', name: 'Fictional juror', roles: ['juror'] },
      packet: `Actor: ${omitted}_ACTOR\nPrivate theory: ${omitted}_PACKET`, previousTurns: `${omitted}_PREVIOUS`,
      groundingContext: `E-001: admitted; authentication status not supplied; ${omitted}_CONTEXT\nE-94321: admitted; authentication status not supplied.`,
      courtroomEvents: [{ eventId: 'outside-focus-record', type: 'public_submission', actorId: 'crown', payload: { text: `${omitted}_EVENT` } }],
      courtroomAssessments: [{ issueId: 'fictional', round: 'initial', choice: 'no_finding', confidence: 50, rationale: `${omitted}_HISTORY`, usable: true }],
      evidence: [{ ...evidence[0], name: `${omitted}_NAME`, summary: `${omitted}_SUMMARY`, extractionWarning: `${omitted}_WARNING`, tags: [omitted] },
        { ...evidence[0], id: 'excluded-focus-source', exhibitId: 'E-94321', text: `${omitted}_OTHER_SOURCE`, authorizedPassages: undefined }],
    }
    const current: StageResult = { ...draft, jurors: [{ juror: 'juror-01', leaning: 'mixed', confidence: 50, rationale: 'OTHER_RATIONALE_UNIT', citations: [], beliefTrail: [], deliberationRounds: [], mindChangedBecause: 'OTHER_CHANGE_UNIT', consistencyWarnings: [] }] }
    const h = harness([reply([1, 2, 4]), reply([1, 2, 4], false, 'unsupported')])
    const review = await h.client.reviewGrounding(q, current, prior([1, 2, 3], current, q))
    expect(review.status).toBe('failed')
    expect(h.bodies).toHaveLength(2)
    assertFocus(h.bodies[1], [1, 2, 4])
    const body = JSON.stringify(h.bodies[1])
    for (const forbidden of [omitted, 'E-94321', 'OTHER_RATIONALE_UNIT', 'OTHER_CHANGE_UNIT', 'outside-focus-record', 'Approved authentication knowledge:']) expect(body).not.toContain(forbidden)
  })
})
