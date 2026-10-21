import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { chronologyDoubtScopeValidationUnits } from '../server/checkerChronologyDoubtScope'
import { groundingUnits, type GroundingReview } from '../server/grounding'
import { MiniMaxClient } from '../server/minimax'

type CapturedAssessment = { id: string; request: any; result: any; checkerContent: string }
const capture: { items: CapturedAssessment[] } = JSON.parse(readFileSync('docs/qa/jury/v209-captured-juror-assessment-scope.json', 'utf8'))
function corrected(item: any) {
  const review = JSON.parse(item.checkerContent)
  Object.assign(review.findings.find((finding: any) => finding.unitId === 'juror-0:1'), {
    status: 'analysis', explanation: 'Assess the complete qualified unit. Personal chronology doubt asserts no established timing. Differing observations with an express non-disproof qualification do not assert incompatible events or use non-observation to prove receipt.',
  })
  return JSON.stringify(review)
}
function harness(outputs: string[], maxRetries = 2) {
  const sent: any[] = []
  const client = new MiniMaxClient({ provider: 'minimax', apiKey: 'fictional', baseUrl: 'https://fixture.invalid/v1', model: 'fixture', timeoutMs: 2000, maxRetries }, undefined,
    async (_url, init) => {
      sent.push(JSON.parse(String(init?.body)))
      return Response.json({ choices: [{ message: { content: outputs[Math.min(sent.length - 1, outputs.length - 1)] } }] })
    })
  return { client, sent }
}
function eligible(item: any, request = item.request, result = item.result) {
  return chronologyDoubtScopeValidationUnits(request, groundingUnits(result), JSON.parse(item.checkerContent) as GroundingReview)
}
const rename = (value: any) => JSON.parse(JSON.stringify(value).replaceAll('Mira', 'Nira').replaceAll('Tavi', 'Savi').replaceAll('Rowan', 'Jordan').replaceAll('Ellis', 'Alex').replaceAll('E-001', 'E-731').replaceAll('E-002', 'E-732'))

describe.each(capture.items)('captured complete juror assessment: $id', item => {
  it('requires a valid new review of every unchanged author field', async () => {
    const { client, sent } = harness([item.checkerContent, corrected(item)])
    const review = await client.reviewGrounding(item.request, item.result)
    expect(review.status).toBe('passed')
    expect(review.verificationRetries).toBe(1)
    expect(sent).toHaveLength(2)
    expect(sent.every(body => body.messages[1].content.includes(item.result.jurors[0].rationale))).toBe(true)
  })
  it('withholds repeated invalid reviews at the existing limit', async () => {
    const { client, sent } = harness([item.checkerContent])
    expect((await client.reviewGrounding(item.request, item.result)).status).toBe('failed')
    expect(sent).toHaveLength(3)
  })
  it('withholds when rechecks are disabled', async () => {
    const { client, sent } = harness([item.checkerContent, corrected(item)], 0)
    expect((await client.reviewGrounding(item.request, item.result)).status).toBe('failed')
    expect(sent).toHaveLength(1)
  })
  it('uses a valid first review without another call', async () => {
    const { client, sent } = harness([corrected(item)])
    expect((await client.reviewGrounding(item.request, item.result)).status).toBe('passed')
    expect(sent).toHaveLength(1)
  })
  it('binds the actual renamed witnesses, participants and sources', async () => {
    const changed = rename(item)
    const { client, sent } = harness([changed.checkerContent, corrected(changed)])
    expect((await client.reviewGrounding(changed.request, changed.result)).status).toBe('passed')
    expect(sent).toHaveLength(2)
  })
  it.each(['context', 'permission', 'profile', 'stage', 'protocol'])('requires actual %s scope', variant => {
    const q = structuredClone(item.request)
    if (variant === 'context') q.groundingContext = ''
    if (variant === 'permission') q.groundingContext = q.groundingContext.replaceAll('Assess the fictional condition using the attributed disputed account.', 'Attribution only.')
    if (variant === 'profile') q.jurorProfiles[0].juror = 'juror-peer'
    if (variant === 'stage') q.stage = 'crown_opening'
    if (variant === 'protocol') q.courtroomProtocol = false
    expect(eligible(item, q)).toEqual([])
  })
  it('does not excuse a separate unsupported content finding', async () => {
    const result = structuredClone(item.result)
    result.content = 'Fictional Rowan destroyed the token. ' + result.content
    const first = JSON.parse(item.checkerContent)
    Object.assign(first.findings.find((finding: any) => finding.unitId === 'content:1'), { status: 'unsupported', explanation: 'Destruction is not supplied by either account.' })
    const { client, sent } = harness([JSON.stringify(first), corrected(item)])
    expect((await client.reviewGrounding(item.request, result)).status).toBe('failed')
    expect(sent).toHaveLength(1)
  })
})

describe('qualified divergence is a bounded comparison of actual differing observations', () => {
  const item = capture.items[1]
  it.each(['direct denial', 'continuous possession', 'relative timing', 'different event', 'omitted observation', 'missing source', 'same source', 'excluded'])('does not exempt %s', variant => {
    const q = structuredClone(item.request)
    if (variant === 'direct denial') q.evidence[1].text = q.evidence[1].text.replace('I did not see a handover.', 'No handover occurred.')
    if (variant === 'continuous possession') q.evidence[1].text += ' Rowan held the token throughout the entire meeting.'
    if (variant === 'relative timing') q.evidence[1].text += ' This happened before Mira arrived.'
    if (variant === 'different event') q.evidence[1].text = q.evidence[1].text.replace('blue token', 'red envelope')
    if (variant === 'omitted observation') q.evidence[1].text = q.evidence[1].text.replace('I did not see a handover.', '')
    if (variant === 'missing source') q.evidence.pop()
    if (variant === 'same source') q.evidence[1].exhibitId = q.evidence[0].exhibitId
    if (variant === 'excluded') q.groundingContext = q.groundingContext.replaceAll(': admitted;', ': excluded;')
    expect(eligible(item, q)).toEqual([])
  })
  it.each([
    'The accounts directly contradict each other about receipt.',
    'The accounts diverge on the handover, but non-observation disproves receipt.',
    'The accounts diverge on the handover, but non-observation does not disprove receipt and establishes an incompatible chronology.',
    'The accounts diverge on the handover, but non-observation does not disprove receipt, so receipt is proved.',
  ])('retains the separate affirmative proposition: %s', text => {
    const result = structuredClone(item.result)
    result.jurors[0].rationale = text
    expect(eligible(item, item.request, result)).toEqual([])
  })
})

describe('chronology doubt still requires the complete attributed quotation', () => {
  const item = capture.items[0]
  it.each(['quote', 'speaker', 'timing'])('does not excuse an invented %s', variant => {
    const result = structuredClone(item.result)
    if (variant === 'quote') result.jurors[0].rationale = result.jurors[0].rationale.replace('hand a blue token', 'destroy a blue token')
    if (variant === 'speaker') result.jurors[0].rationale = result.jurors[0].rationale.replace('records Mira stating', 'records Tavi stating')
    if (variant === 'timing') result.jurors[0].rationale = result.jurors[0].rationale.replace('cause doubt:', 'establish that the departure preceded the handover:')
    expect(eligible(item, item.request, result)).toEqual([])
  })
})
