import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ballotConsistencyUnits, groundingUnits, parseGroundingReview } from '../server/grounding'
import { MiniMaxClient } from '../server/minimax'

const capture = JSON.parse(readFileSync('docs/qa/jury/v211-captured-inverse-nonoccurrence-proof.json', 'utf8'))
function inspect(result: any, whole = false) {
  const q = capture.request
  const units = whole ? ballotConsistencyUnits(result) : groundingUnits(result)
  return parseGroundingReview(JSON.stringify({ findings: units.map(unit => ({ unitId: unit.id, status: 'analysis', explanation: 'Offline injected labels, not a live grade.', citations: [], recordCitations: [] })) }), units, q.evidence, q.groundingContext,
    { actorId: q.courtroomActor.id, assessments: q.courtroomAssessments, profile: q.jurorProfiles[0] },
    { packet: q.packet, events: q.courtroomEvents, actorRoles: q.courtroomActor.roles, partyRoles: q.approvedPartyRoles, actor: q.courtroomActor, stage: q.stage, ballotRound: q.ballotRound, courtroomState: q.courtroomState })
}
function draft(content: string) {
  const result = structuredClone(capture.acceptedRepair)
  result.content = content
  return result
}

describe('absence of proof of non-occurrence cannot establish receipt', () => {
  it.each([false, true])('retains the isolated actual inverse proof co-basis, whole=%s', whole => {
    expect(inspect(capture.derivedHistoryCorrectedDraft, whole).status).toBe('failed')
  })
  it('rejects the recorded checker judgment after only the unrelated history finding is corrected', async () => {
    let calls = 0
    const client = new MiniMaxClient({ provider: 'minimax', apiKey: 'fictional', baseUrl: 'https://fixture.invalid/v1', model: 'fixture', timeoutMs: 2000, maxRetries: 0 }, undefined, async () => {
      calls++
      return Response.json({ choices: [{ message: { content: capture.derivedInjectedCheckerContent } }] })
    })
    expect((await client.reviewGrounding(capture.request, capture.derivedHistoryCorrectedDraft)).status).toBe('failed')
    expect(calls).toBe(1)
  })
  it.each(['establish', 'prove', 'show', 'demonstrate'])('rejects a conjoined inverse-%s reason even with explicit credit', verb => {
    const result = draft(`I vote guilty because I credit Mira’s direct account and Tavi’s statement does not ${verb} that no handover occurred.`)
    expect(inspect(result).status).toBe('failed')
    expect(inspect(result, true).status).toBe('failed')
  })
  it.each([
    'Tavi’s statement has not established that no handover occurred',
    'Tavi’s statement does not itself prove that receipt did not occur',
    'Tavi’s statement doesn’t demonstrate the absence of a handover',
    'Tavi’s statement fails to prove non-receipt',
  ])('retains the same inverse proof boundary across ordinary forms: %s', reason => {
    const result = draft(`I vote guilty because I credit Mira’s direct account and ${reason}.`)
    expect(inspect(result).status).toBe('failed')
    expect(inspect(result, true).status).toBe('failed')
  })
  it.each([
    'I credit Mira beyond a reasonable doubt because Tavi’s account does not establish non-receipt.',
    'Because Tavi’s account does not prove that no handover occurred, I credit Mira beyond a reasonable doubt.',
  ])('rejects an inverse comparison used directly as the credit reason: %s', content => {
    expect(inspect(draft(content)).status).toBe('failed')
  })
  it.each([
    'Tavi’s account does not establish non-receipt, therefore the Crown has proved receipt beyond a reasonable doubt.',
    'Tavi’s statement does not prove that no handover occurred, so I find receipt established beyond a reasonable doubt.',
  ])('rejects an inverse comparison explicitly supplying a proof consequence: %s', content => {
    expect(inspect(draft(content)).status).toBe('failed')
  })
  it('checks a rationale independently of a safe neighboring proof finding', () => {
    const result = draft('I credit Mira’s permitted direct handover account beyond a reasonable doubt.')
    result.jurors[0].rationale = 'I credit Mira because its account describes receipt and Tavi’s account does not establish non-receipt.'
    expect(inspect(result).status).toBe('failed')
    expect(inspect(result, true).status).toBe('failed')
  })
  it.each([
    'I credit Mira’s direct account beyond a reasonable doubt. Tavi’s statement does not establish that no handover occurred.',
    'While Tavi’s statement does not establish non-receipt, I independently credit Mira’s direct account beyond a reasonable doubt.',
    'I credit Mira’s direct account beyond a reasonable doubt; I do not treat Tavi’s non-observation as proof that no handover occurred.',
    'If Tavi’s statement did not establish non-receipt, that alone would not establish receipt. I credit Mira’s direct account beyond a reasonable doubt.',
  ])('retains a comparison without assigning it positive proof value: %s', content => {
    const result = draft(content)
    expect(inspect(result).status).toBe('passed')
    expect(inspect(result, true).status).toBe('passed')
  })
  it('retains the actual accepted repair as the positive control', () => {
    expect(inspect(capture.acceptedRepair).status).toBe('passed')
    expect(inspect(capture.acceptedRepair, true).status).toBe('passed')
  })
  it('retains stable metadata that credits an account and rejects misuse of non-observation', () => {
    const result = draft('I credit Mira’s direct account beyond a reasonable doubt.')
    result.jurors[0].mindChangedBecause = 'Stable because I credit E-001’s direct attributed account and do not treat E-002’s non-observation as denial.'
    expect(inspect(result).status).toBe('passed')
    expect(inspect(result, true).status).toBe('passed')
  })
  it('does not turn a negative proof finding after a fronted reason into a Crown finding', () => {
    const result = draft('Because Tavi’s account does not establish non-receipt, I do not credit Mira beyond a reasonable doubt.')
    result.jurors[0].leaning = 'defence'
    result.jurors[0].rationale = 'I retain reasonable doubt on the permitted accounts.'
    result.jurors[0].mindChangedBecause = 'This is my initial ballot.'
    expect(inspect(result).status).toBe('passed')
    expect(inspect(result, true).status).toBe('passed')
  })
  it.each(['and', 'but'])('retains a separate affirmative absence after a method correction joined by %s', join => {
    const result = draft(`I credit Mira’s direct account beyond a reasonable doubt; I do not treat Tavi’s non-observation as proof that no handover occurred, ${join} no handover occurred.`)
    expect(inspect(result).status).toBe('failed')
  })
})
