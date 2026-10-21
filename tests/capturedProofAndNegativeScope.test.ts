import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ballotConsistencyUnits, groundingUnits, parseGroundingReview } from '../server/grounding'
import { MiniMaxClient } from '../server/minimax'

const capture = JSON.parse(readFileSync('docs/qa/jury/v206-captured-proof-and-negative-scope.json', 'utf8'))
function check(item: any, result = item.result, whole = false) {
  const q = item.request
  const units = whole ? ballotConsistencyUnits(result) : groundingUnits(result)
  return parseGroundingReview(JSON.stringify({ findings: units.map(unit => ({ unitId: unit.id, status: 'analysis', explanation: 'Injected labels for offline application regression only.', citations: [], recordCitations: [] })) }), units, q.evidence, q.groundingContext,
    { actorId: q.courtroomActor.id, assessments: q.courtroomAssessments, profile: q.jurorProfiles[0] },
    { packet: q.packet, events: q.courtroomEvents, actorRoles: q.courtroomActor.roles, partyRoles: q.approvedPartyRoles, actor: q.courtroomActor, stage: q.stage, ballotRound: q.ballotRound })
}
function harness(outputs: string[], maxRetries = 0) {
  const sent: any[] = []
  const client = new MiniMaxClient({ provider: 'minimax', apiKey: 'fictional', baseUrl: 'https://fixture.invalid/v1', model: 'fixture', timeoutMs: 2000, maxRetries }, undefined,
    async (_url, init) => {
      sent.push(JSON.parse(String(init?.body)))
      return Response.json({ choices: [{ message: { content: outputs[Math.min(sent.length - 1, outputs.length - 1)] } }] })
    })
  return { client, sent }
}
function inField(text: string, field = 'rationale') {
  const result = structuredClone(capture.independentAssessmentPositives[0].result)
  result.content = 'I credit Mira and find the receipt condition proved beyond a reasonable doubt (E-001).'
  result.jurors[0].rationale = 'I independently credit the permitted receipt account (E-001).'
  result.jurors[0].mindChangedBecause = 'This is my initial assessment.'
  if (field === 'title' || field === 'content') result[field] = text
  else result.jurors[0][field] = text
  return result
}

describe('fronted absent timing cannot establish credit or proof', () => {
  const item = capture.unsafeTimingProof
  it('withholds the actual accepted original with its actual checker content', async () => {
    const { client } = harness([item.checker.content])
    expect((await client.reviewGrounding(item.request, item.result)).status).toBe('failed')
  })
  it('withholds the exact current fields and whole ballot', () => {
    expect(check(item).status).toBe('failed')
    expect(check(item, item.result, true).status).toBe('failed')
  })
  it.each(['title', 'content', 'rationale', 'mindChangedBecause'])('checks the timing-to-credit reason in %s', field => {
    const result = inField('Without supplied incompatible timing, I credit Mira and find the pinned condition proved beyond a reasonable doubt.', field)
    expect(check(item, result).status).toBe('failed')
    expect(check(item, result, true).status).toBe('failed')
  })
  it.each([
    'Without provided contradictory timing, I credit Mira.',
    'Without recorded conflicting timing, I credit Mira.',
    'Without supplied relative timing, I credit Mira.',
  ])('withholds an equivalent current causal premise: %s', text => {
    const result = inField(text)
    expect(check(item, result).status).toBe('failed')
    expect(check(item, result, true).status).toBe('failed')
  })
  it.each([
    'Without supplied incompatible timing, I cannot call the accounts contradictory. I independently credit Mira.',
    'Without supplied incompatible timing, comparison is unresolved, but I independently credit Mira.',
    'Without supplied incompatible timing, I cannot credit Mira from that gap alone. I independently credit Mira’s admitted account.',
    'Would I credit Mira without supplied incompatible timing?',
  ])('preserves a bounded comparison, separate assessment or question: %s', text => {
    const result = inField(text)
    expect(check(item, result).status).toBe('passed')
    expect(check(item, result, true).status).toBe('passed')
  })
  it('binds the actual source names and exhibit IDs', () => {
    const renamed = JSON.parse(JSON.stringify(item).replaceAll('Mira', 'Nira').replaceAll('Tavi', 'Savi').replaceAll('E-001', 'E-731').replaceAll('E-002', 'E-732'))
    expect(check(renamed).status).toBe('failed')
    expect(check(renamed, renamed.result, true).status).toBe('failed')
  })
})

describe('not establishing non-occurrence is distinct from asserting non-occurrence', () => {
  const item = capture.falseNonOccurrenceRejection
  it('preserves the exact original with its positive actual checker findings', async () => {
    const { client } = harness([item.checker.content])
    expect((await client.reviewGrounding(item.request, item.result)).status).toBe('passed')
  })
  it.each(['establishing', 'proving', 'showing'])('preserves the scoped without-%s clause', verb => {
    const result = structuredClone(item.result)
    result.content = result.content.replace('without establishing that', `without ${verb} that`)
    expect(check(item, result).status).toBe('passed')
    expect(check(item, result, true).status).toBe('passed')
  })
  it('does not clear a separate affirmative no-handover assertion', () => {
    const result = structuredClone(item.result)
    result.content += ' But no handover occurred.'
    // Source support belongs to field review; the whole-ballot unit separately
    // reviews proof coherence and does not duplicate every source predicate.
    expect(check(item, result).status).toBe('failed')
  })
})

describe('current comparative weight and retained doubt require resolved proof scope', () => {
  const item = capture.unclearDoubtProof
  it('withholds the actual unresolved whole ballot without prescribing an outcome', async () => {
    const { client } = harness([item.checker.content])
    expect((await client.reviewGrounding(item.request, item.result)).status).toBe('failed')
  })
  it('checks the complete actual whole ballot', () => expect(check(item, item.result, true).status).toBe('failed'))
  it.each([
    'I give Mira greater weight and find the receipt condition proved beyond a reasonable doubt, despite remaining doubts.',
    'My remaining doubts are not reasonable; I credit Mira and find receipt proved beyond a reasonable doubt.',
  ])('preserves residual doubt with a clear proof finding: %s', rationale => {
    const result = structuredClone(item.result)
    result.jurors[0].rationale = rationale
    expect(check(item, result).status).toBe('passed')
    expect(check(item, result, true).status).toBe('passed')
  })
  it('preserves personal reasonable doubt with a Defence outcome', () => {
    const result = structuredClone(item.result)
    result.content = 'I retain reasonable doubt about the receipt condition.'
    result.jurors[0].leaning = 'defence'
    result.jurors[0].rationale = 'Mira receives greater weight, but I retain reasonable doubt about receipt.'
    expect(check(item, result).status).toBe('passed')
    expect(check(item, result, true).status).toBe('passed')
  })
  it.each([
    'I give Mira greater weight, but I do not find receipt proved beyond a reasonable doubt; I retain doubt.',
    'I give Mira greater weight and retain doubt. The Crown must prove receipt beyond a reasonable doubt.',
  ])('does not resolve current proof scope with a negative finding or instruction recital: %s', rationale => {
    const result = structuredClone(item.result)
    result.jurors[0].rationale = rationale
    expect(check(item, result, true).status).toBe('failed')
  })
  it.each(capture.independentAssessmentPositives as { id: string; request: any; result: any }[])('preserves current independently reviewed assessment: $id', positive => {
    expect(check(positive).status).toBe('passed')
    expect(check(positive, positive.result, true).status).toBe('passed')
  })
})

describe('scoped visible-event absence in actual initial metadata', () => {
  const item = capture.falseInitialContextRejection
  const corrected = JSON.parse(item.checker.content)
  const finding = corrected.findings.find((f: any) => f.unitId === 'juror-change-0:1')
  finding.status = 'analysis'
  finding.explanation = 'The actual initial round, explicit empty own history and supplied visible events support this scoped current initial-position statement; no invisible history is claimed.'
  const valid = JSON.stringify(corrected)
  it('requires and obtains a valid new review of the unchanged draft', async () => {
    const { client, sent } = harness([item.checker.content, valid], 2)
    const review = await client.reviewGrounding(item.request, item.result)
    expect(review.status).toBe('passed')
    expect(review.verificationRetries).toBe(1)
    expect(sent).toHaveLength(2)
    expect(sent.every(body => body.messages[1].content.includes(item.result.jurors[0].mindChangedBecause))).toBe(true)
  })
  it('keeps invalid rechecks failed at the same retry boundary', async () => {
    const { client, sent } = harness([item.checker.content], 2)
    expect((await client.reviewGrounding(item.request, item.result)).status).toBe('failed')
    expect(sent).toHaveLength(3)
  })
  it.each(['history', 'events', 'round'])('does not infer missing actual %s setup', async key => {
    const q = structuredClone(item.request)
    if (key === 'history') delete q.courtroomAssessments
    if (key === 'events') delete q.courtroomEvents
    if (key === 'round') q.ballotRound = 'final'
    const { client, sent } = harness([item.checker.content, valid], 2)
    expect((await client.reviewGrounding(q, item.result)).status).toBe('failed')
    expect(sent).toHaveLength(1)
  })
  it('does not recheck an appended unsupported assertion', async () => {
    const result = structuredClone(item.result)
    result.jurors[0].mindChangedBecause += ' The Crown has proved receipt.'
    const { client, sent } = harness([item.checker.content, valid], 2)
    expect((await client.reviewGrounding(item.request, result)).status).toBe('failed')
    expect(sent).toHaveLength(1)
  })
})
