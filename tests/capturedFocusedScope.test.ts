import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ballotConsistencyUnits, groundingUnits, parseGroundingReview } from '../server/grounding'
import { MiniMaxClient } from '../server/minimax'

const capture = JSON.parse(readFileSync('docs/qa/jury/v193-captured-focused-failures.json', 'utf8'))
const [absence, causal, authentication] = capture.items
function inspect(item: any, result = item.result, whole = false) {
  const q = item.request
  const units = whole ? ballotConsistencyUnits(result) : groundingUnits(result)
  return parseGroundingReview(JSON.stringify({ findings: units.map(unit => ({ unitId: unit.id, status: 'analysis', explanation: 'Assess the supplied fictional accounts.', citations: [], recordCitations: [] })) }), units, q.evidence, q.groundingContext,
    { actorId: q.courtroomActor.id, assessments: q.courtroomAssessments, profile: q.jurorProfiles[0] },
    { packet: q.packet, events: q.courtroomEvents, actorRoles: q.courtroomActor.roles, partyRoles: q.approvedPartyRoles, actor: q.courtroomActor, stage: q.stage, ballotRound: q.ballotRound })
}
function harness(outputs: string[], maxRetries = 2) {
  const sent: any[] = []
  const client = new MiniMaxClient({ provider: 'minimax', apiKey: 'fictional', baseUrl: 'https://fixture.invalid/v1', model: 'fixture', timeoutMs: 2000, maxRetries }, undefined, async (_url, init) => {
    sent.push(JSON.parse(String(init?.body)))
    return Response.json({ choices: [{ message: { content: outputs[Math.min(sent.length - 1, outputs.length - 1)] } }] })
  })
  return { client, sent }
}

describe('captured nested denial of established event absence', () => {
  it('preserves the actual original draft and accepted raw review', async () => {
    const { client, sent } = harness([absence.checkerContent], 0)
    expect((await client.reviewGrounding(absence.request, absence.result)).status).toBe('passed')
    expect(sent).toHaveLength(1)
    expect(inspect(absence).status).toBe('passed')
    expect(inspect(absence, absence.result, true).status).toBe('passed')
  })
  it.each([
    'Tavi’s non-observation does not establish that no handover occurred.',
    'Tavi’s non-observation does not prove no handover occurred.',
    'Tavi’s non-observation is not evidence that no handover occurred.',
  ])('preserves negative proof scope: %s', content => {
    const result = structuredClone(absence.result)
    result.content = content
    expect(inspect(absence, result).status).toBe('passed')
  })
  it.each(['but', 'and', 'yet'])('retains a separate event denial after %s', join => {
    const result = structuredClone(absence.result)
    result.content = `Tavi’s non-observation does not establish that no handover occurred, ${join} no handover occurred.`
    expect(inspect(absence, result).status).toBe('failed')
  })
  it('retains affirmative proof of absence', () => {
    const result = structuredClone(absence.result)
    result.content = 'Tavi’s non-observation establishes that no handover occurred.'
    expect(inspect(absence, result).status).toBe('failed')
  })
})

describe('captured fronted timing gap used as affirmative proof credit', () => {
  it('withholds the actual final repair despite its all-accept raw checker response', async () => {
    const { client } = harness([causal.checkerContent], 0)
    expect((await client.reviewGrounding(causal.request, causal.result)).status).toBe('failed')
    expect(inspect(causal).status).toBe('failed')
    expect(inspect(causal, causal.result, true).status).toBe('failed')
  })
  it('retains the original proof co-basis in metadata even after the rationale is corrected', () => {
    const result = structuredClone(causal.result)
    result.jurors[0].rationale = 'I credit Mira’s direct account after weighing the permitted description of the condition.'
    const review = inspect(causal, result)
    expect(review.status).toBe('failed')
    expect(review.findings.some(finding => finding.unitId.startsWith('juror-change-') && finding.status === 'unsupported')).toBe(true)
    expect(inspect(causal, result, true).status).toBe('failed')
  })
  it.each(['title', 'content', 'rationale', 'mindChangedBecause'])('checks the causal premise independently in %s', field => {
    const result = structuredClone(causal.result)
    result.jurors[0].rationale = 'I credit Mira’s direct account after weighing the permitted description of the condition.'
    result.jurors[0].mindChangedBecause = 'This is my initial ballot.'
    const text = 'Given no supplied timing, I credit Mira beyond reasonable doubt.'
    if (field === 'title' || field === 'content') result[field] = text
    else result.jurors[0][field] = text
    expect(inspect(causal, result).status).toBe('failed')
    expect(inspect(causal, result, true).status).toBe('failed')
  })
  it.each([
    'No supplied timing is available. I credit Mira because the actual account directly describes the listed condition.',
    'Given no supplied timing, I retain doubt about receipt beyond reasonable doubt.',
    'If I credited Mira given no supplied timing, that would not resolve the condition.',
    'It is incorrect to conclude that given no supplied timing, I credit Mira beyond reasonable doubt.',
    'I credit Mira’s direct description of the condition, not because no supplied timing is available.',
  ])('preserves separate context, personal doubt and disowned causal claims: %s', rationale => {
    const result = structuredClone(causal.result)
    result.jurors[0].rationale = rationale
    // Isolate the intended rationale; the original proof co-basis stays tested above.
    result.jurors[0].mindChangedBecause = 'This is my initial ballot.'
    if (rationale.includes('I retain doubt')) {
      result.jurors[0].leaning = 'defence'
      result.content = 'I retain doubt about receipt beyond reasonable doubt.'
      result.jurors[0].mindChangedBecause = 'This is my initial ballot.'
    }
    expect(inspect(causal, result).status).toBe('passed')
  })
})

function scopedAuthenticationDraft() {
  const result = structuredClone(authentication.result)
  // Preserve the original. Qualify only this derived positive's history claim.
  result.jurors[0].mindChangedBecause = 'This is my initial ballot, and no visible deliberation event is supplied.'
  return result
}
const acceptedAuthentication = JSON.parse(authentication.checkerContent)
const authFinding = acceptedAuthentication.findings.find((finding: any) => finding.unitId === 'juror-0:1')
authFinding.status = 'analysis'
authFinding.explanation = 'The actual condition details are in Mira’s attributed account. Both sources have unknown classification and explicitly unsupplied authentication, so these statuses are unknown within the supplied record.'

describe('conjoined epistemic authentication and classification scope', () => {
  it('requires a new review of the same derived draft instead of accepting a negative review', async () => {
    const result = scopedAuthenticationDraft()
    const { client, sent } = harness([authentication.checkerContent, JSON.stringify(acceptedAuthentication)])
    const review = await client.reviewGrounding(authentication.request, result)
    expect(review.status, JSON.stringify(review)).toBe('passed')
    expect(review.verificationRetries).toBe(1)
    expect(sent).toHaveLength(2)
    expect(sent[1].messages[1].content).toContain('authentication-status scope mismatch')
    expect(sent.every(body => body.messages[1].content.includes(result.jurors[0].rationale))).toBe(true)
  })
  it('withholds repeated invalid reviews at the unchanged retry limit', async () => {
    const { client, sent } = harness([authentication.checkerContent])
    expect((await client.reviewGrounding(authentication.request, scopedAuthenticationDraft())).status).toBe('failed')
    expect(sent).toHaveLength(3)
  })
  it.each(['omitted', 'known classification', 'known authentication', 'extra claim', 'wrong speaker', 'missing second source'])('does not recover an unsupported or incomplete setup: %s', variant => {
    const request = structuredClone(authentication.request)
    const result = scopedAuthenticationDraft()
    if (variant === 'omitted') request.groundingContext = ''
    if (variant === 'known classification') request.groundingContext = request.groundingContext.replace('E-002: unclassified; unknown;', 'E-002: primary; verified;')
    if (variant === 'known authentication') request.packet += '\nAuthentication status: authenticated.'
    if (variant === 'extra claim') result.jurors[0].rationale = result.jurors[0].rationale.replace('are unknown.', 'are unknown, so no handover occurred.')
    if (variant === 'wrong speaker') result.jurors[0].rationale = result.jurors[0].rationale.replace('Mira’s', 'Invented’s')
    if (variant === 'missing second source') request.evidence = request.evidence.slice(0, 1)
    const { client, sent } = harness([authentication.checkerContent])
    return client.reviewGrounding(request, result).then(review => {
      expect(review.status).toBe('failed')
      expect(sent).toHaveLength(1)
    })
  })
})
