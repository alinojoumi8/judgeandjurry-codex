import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ballotConsistencyUnits, groundingUnits, parseGroundingReview } from '../server/grounding'
import { MiniMaxClient } from '../server/minimax'

type CapturedCase = { id: string; expected: string; request: any; result: any; checkerContent: string }
const capture = JSON.parse(readFileSync('docs/qa/jury/v194-captured-calibration-failures.json', 'utf8')) as { items: CapturedCase[] }
const item = (id: string) => capture.items.find(x => x.id === id)!
const timing = item('captured-departing-observation-negative')
const history = item('captured-coordinated-observation-negative')
const purpose = item('captured-corrob-documentary-absence-negative-1-original')
const chronology = item('captured-exclusive-prove-bar-negative-2-original')
function inspect(c: any, result = c.result, whole = false, request = c.request) {
  const q = request, units = whole ? ballotConsistencyUnits(result) : groundingUnits(result)
  return parseGroundingReview(JSON.stringify({ findings: units.map(unit => ({ unitId: unit.id, status: 'analysis', explanation: 'Assess the actual supplied sources.', citations: [], recordCitations: [] })) }), units, q.evidence, q.groundingContext,
    { actorId: q.courtroomActor.id, assessments: q.courtroomAssessments, profile: q.jurorProfiles[0] },
    q.courtroomEvents ? { packet: q.packet, events: q.courtroomEvents, actorRoles: q.courtroomActor.roles, partyRoles: q.approvedPartyRoles, actor: q.courtroomActor, stage: q.stage, ballotRound: q.ballotRound } : undefined)
}
function harness(outputs: string[], maxRetries = 2) {
  const sent: any[] = []
  const client = new MiniMaxClient({ provider: 'minimax', apiKey: 'fictional', baseUrl: 'https://fixture.invalid/v1', model: 'fixture', timeoutMs: 2000, maxRetries }, undefined, async (_url, init) => {
    sent.push(JSON.parse(String(init?.body)))
    return Response.json({ choices: [{ message: { content: outputs[Math.min(sent.length - 1, outputs.length - 1)] } }] })
  })
  return { client, sent }
}
function safeTimingDraft() {
  const result = structuredClone(timing.result)
  result.content = 'I credit Mira’s actual direct handover account beyond reasonable doubt.'
  result.jurors[0].rationale = 'I credit Mira’s actual direct handover account beyond reasonable doubt.'
  result.jurors[0].mindChangedBecause = 'This is my initial ballot.'
  return result
}

describe('actual calibration acceptances and original false rejections', () => {
  it.each(capture.items.filter((x: any) => x.expected === 'failed'))('withholds the actual accepted $id without choosing an outcome', async c => {
    const { client } = harness([c.checkerContent], 0)
    expect((await client.reviewGrounding(c.request, c.result)).status).toBe('failed')
  })
  it.each(capture.items.filter((x: any) => x.expected === 'passed' && x.id !== chronology.id))('preserves the faithful original $id using its actual all-accept review', async c => {
    const { client, sent } = harness([c.checkerContent], 0)
    expect((await client.reviewGrounding(c.request, c.result)).status).toBe('passed')
    expect(sent).toHaveLength(1)
  })
})

describe('nominal timing reasons and proof conclusions', () => {
  it.each([
    'I credit Mira because the latter account supplies no incompatible timing.',
    'I credit Mira because the other source supplies no relative timing.',
    'With no supplied timing, I credit the direct account beyond reasonable doubt.',
    'With no supplied timing, I find the burden met beyond reasonable doubt.',
    'Timing is unspecified, so I find the burden met beyond reasonable doubt.',
    'With no supplied timing, I retain doubt about whether the Crown proved receipt, but I credit Mira beyond reasonable doubt.',
  ])('rejects the causal shortcut in both field and whole-ballot context: %s', text => {
    const result = safeTimingDraft()
    result.jurors[0].rationale = 'Mira’s account directly describes the handover. ' + text
    expect(inspect(timing, result).status).toBe('failed')
    expect(inspect(timing, result, true).status).toBe('failed')
  })
  it.each([
    'No supplied timing is available. I credit Mira’s direct account and find the burden met beyond reasonable doubt.',
    'I credit Mira because the actual source describes the listed condition, while relative timing is unspecified.',
    'I do not credit Mira merely because the latter account supplies no incompatible timing.',
    'It is incorrect to conclude with no supplied timing, I credit Mira beyond reasonable doubt.',
    'If timing were unspecified, that would not establish proof or credibility.',
  ])('preserves independent assessment and disowned causal shortcuts: %s', text => {
    const result = safeTimingDraft()
    result.jurors[0].rationale = text
    expect(inspect(timing, result).status).toBe('passed')
  })
  it.each([
    'With no supplied timing, I retain doubt about whether the Crown proved receipt beyond a reasonable doubt.',
    'Timing is unspecified, so I retain doubt about whether the Crown proved receipt beyond a reasonable doubt.',
  ])('preserves a personal doubt assessment from missing timing: %s', rationale => {
    const result = safeTimingDraft()
    result.content = 'I find the Crown has not proved receipt beyond a reasonable doubt.'
    result.jurors[0].leaning = 'defence'
    result.jurors[0].rationale = rationale
    expect(inspect(timing, result).status).toBe('passed')
  })
})

describe('deliberation-event occurrence remains scoped to supplied history', () => {
  it.each(['No deliberation event has occurred.', 'No deliberation events have occurred.', 'Deliberation events have not occurred.'])('withholds unqualified absence: %s', text => {
    const result = safeTimingDraft()
    result.jurors[0].mindChangedBecause = text
    expect(inspect(history, result).status).toBe('failed')
  })
  it.each(['No visible deliberation event has occurred.', 'No visible deliberation has occurred.', 'No deliberation event has occurred in the supplied record.', 'In the visible history, no deliberation event has occurred.'])('preserves actual record-scoped absence: %s', text => {
    const result = safeTimingDraft()
    result.jurors[0].mindChangedBecause = text
    expect(inspect(history, result).status).toBe('passed')
  })
  it.each(['omitted event', 'contradictory event', 'omitted deliberation', 'contradictory deliberation'])('requires an actual noncontradictory inventory: %s', variant => {
    const result = safeTimingDraft()
    result.jurors[0].mindChangedBecause = variant.endsWith('event') ? 'No visible deliberation event has occurred.' : 'No visible deliberation has occurred.'
    const request = structuredClone(history.request)
    request.courtroomEvents = variant.startsWith('omitted') ? undefined : [...request.courtroomEvents, { type: 'jury_deliberation', phase: 'deliberation', eventId: 'actual-deliberation', actorId: 'juror-02', payload: {} }]
    expect(inspect(history, result, false, request).status).toBe('failed')
  })
  it('preserves a hypothetical occurrence absence', () => {
    const result = safeTimingDraft()
    result.jurors[0].mindChangedBecause = 'If no deliberation event has occurred, that would not establish receipt.'
    expect(inspect(history, result).status).toBe('passed')
  })
})

describe('proof threshold attaches to Crown proof rather than retained doubt', () => {
  it('preserves personal doubt about whether receipt was proved to the supplied standard', () => {
    const c = item('captured-exclusive-prove-bar-negative-3')
    const result = structuredClone(c.result)
    result.content = 'I find the Crown has not proved receipt beyond a reasonable doubt.'
    result.jurors[0].rationale = 'I retain doubt about whether receipt was proved beyond a reasonable doubt.'
    expect(inspect(c, result).status).toBe('passed')
    expect(inspect(c, result, true).status).toBe('passed')
  })
})

describe('negative timing and exclusive-purpose comparisons keep clause scope', () => {
  it.each(['but', 'and', 'yet'])('does not clear a separate asserted incompatibility after %s', join => {
    const c = item('captured-authentication-negative-original')
    const result = structuredClone(c.result)
    result.content = `Tavi supplies no timing that makes the accounts incompatible, ${join} the accounts are incompatible.`
    expect(inspect(c, result).status).toBe('failed')
  })
  it.each(['but', 'and'])('does not clear a separate proof grant after a prevention predicate joined by %s', join => {
    const result = structuredClone(purpose.result)
    result.jurors[0].rationale = `Its attribution-only purpose prevents using it to establish occurrence, ${join} it establishes the receipt condition.`
    expect(inspect(purpose, result).status).toBe('failed')
  })
})

const correctedChronology = JSON.parse(chronology.checkerContent)
Object.assign(correctedChronology.findings.find((x: any) => x.unitId === 'juror-0:1'), {
  status: 'analysis', explanation: 'These exact attributed source quotations are faithful. Personal chronology-and-credibility doubt asserts no established relative timing, and may consider missing timing without imposing an extra proof requirement.',
})
describe('personal chronology doubt is not an asserted chronological fact', () => {
  it('requires a valid new review of the same draft', async () => {
    const { client, sent } = harness([chronology.checkerContent, JSON.stringify(correctedChronology)])
    const review = await client.reviewGrounding(chronology.request, chronology.result)
    expect(review.status).toBe('passed')
    expect(review.verificationRetries).toBe(1)
    expect(sent).toHaveLength(2)
    expect(sent[1].messages[1].content).toContain('checker chronology-doubt scope mismatch')
    expect(sent.every(body => body.messages[1].content.includes(chronology.result.jurors[0].rationale))).toBe(true)
  })
  it('withholds repeated invalid reviews at the unchanged retry limit', async () => {
    const { client, sent } = harness([chronology.checkerContent])
    expect((await client.reviewGrounding(chronology.request, chronology.result)).status).toBe('failed')
    expect(sent).toHaveLength(3)
  })
  it.each(['changed quote', 'extra timing claim', 'restricted use', 'peer profile'])('retains the rejection when the pure correction contract is absent: %s', variant => {
    const request = structuredClone(chronology.request), result = structuredClone(chronology.result)
    if (variant === 'changed quote') result.jurors[0].rationale = result.jurors[0].rationale.replace('Rowan', 'Invented')
    if (variant === 'extra timing claim') result.jurors[0].rationale = result.jurors[0].rationale.replace('cause doubt:', 'cause doubt after the handover:')
    if (variant === 'restricted use') request.groundingContext = request.groundingContext.replaceAll('Assess the fictional condition using the attributed disputed account.', 'Accurately attribute the disputed account only; not proof of receipt.')
    if (variant === 'peer profile') request.jurorProfiles[0].juror = 'juror-peer'
    const { client, sent } = harness([chronology.checkerContent])
    return client.reviewGrounding(request, result).then(review => {
      expect(review.status).toBe('failed')
      expect(sent).toHaveLength(1)
    })
  })
})
