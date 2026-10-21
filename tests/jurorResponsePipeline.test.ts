import { describe, expect, it } from 'vitest'
import { MiniMaxClient, normalizeStageResult, type StageRequest } from '../server/minimax'
import { groundingMessages, groundingUnits, parseGroundingReview } from '../server/grounding'
import { supportedOpeningSource } from '../samples/courtroom-realism/supported-opening'
import type { JurorProfile } from '../server/types'

const evidence = [{ ...supportedOpeningSource, exhibitId: 'E-001', text: 'The ledger records a payment of $300 from Rowan to Ellis.' }]
const longReason = 'I assess the supplied ledger against the specified issue and retain my own assessment after considering the competing interpretations described in this discussion, while distinguishing a recorded entry from a finding about its purpose and without relying on unstated transaction purposes: the ledger records $300 (E-001, para. 1).'
const draft = {
  title: 'Current assessment', content: 'The ledger records $300 (E-001, para. 1).', citations: ['E-001'],
  jurors: [{ juror: 'Juror 1', leaning: 'mixed', confidence: 60, rationale: longReason, citations: ['E-001'],
    beliefTrail: [{ stage: 'current', leaning: 'mixed', confidence: 60, belief: longReason, why: longReason, citations: ['E-001'] }],
    deliberationRounds: [{ round: 1, focus: longReason, exchange: longReason, responseTo: longReason, leaning: 'mixed', confidence: 60 }],
    mindChangedBecause: longReason, consistencyWarnings: [] as string[],
  }],
}

describe('juror response integrity', () => {
  it('preserves complete nested explanations and citation endings before audit and storage', () => {
    const normalized = normalizeStageResult(JSON.stringify(draft), 'jury_deliberation', evidence)
    expect(normalized.jurors).toEqual(draft.jurors)
    expect(groundingUnits(normalized).some(unit => unit.text === longReason)).toBe(true)
  })

  it.each([300, 900])('audits the payment amount %i after the former character cutoff', amount => {
    const changed = structuredClone(draft)
    changed.jurors[0].mindChangedBecause = longReason.replace('$300', `$${amount}`)
    const normalized = normalizeStageResult(JSON.stringify(changed), 'jury_deliberation', evidence)
    const units = groundingUnits(normalized).filter(unit => unit.id.startsWith('juror-change-'))
    expect(units.some(unit => unit.text.includes(`$${amount}`))).toBe(true)
    const review = parseGroundingReview(JSON.stringify({ findings: units.map(unit => ({ unitId: unit.id, status: 'supported', citations: [{ exhibitId: 'E-001', paragraph: 1 }] })) }), units, evidence)
    expect(review.status).toBe(amount === 300 ? 'passed' : 'failed')
  })

  it('keeps every consistency warning available for checking, including unsupported trailing assertions', () => {
    const response = structuredClone(draft)
    response.jurors[0].consistencyWarnings = [...Array<string>(6).fill('I retain doubt.'), 'The ledger records $900.']
    const normalized = normalizeStageResult(JSON.stringify(response), 'jury_deliberation', evidence)
    const units = groundingUnits(normalized).filter(unit => unit.id.startsWith('juror-warning-0-6:'))
    expect(units).toHaveLength(1)
    const review = parseGroundingReview(JSON.stringify({ findings: [{ unitId: units[0].id, status: 'supported', citations: [{ exhibitId: 'E-001', paragraph: 1 }] }] }), units, evidence)
    expect(review.status).toBe('failed')
  })
})

const profile = { juror: 'Juror 1', skepticismLevel: 50, burdenSensitivity: 60 } as JurorProfile
const config = { provider: 'openai-compatible' as const, model: 'offline', apiKey: 'fixture', baseUrl: 'http://127.0.0.1:11434/v1', timeoutMs: 1000, maxRetries: 0 }

async function authorPrompt(overrides: Partial<StageRequest>) {
  let prompt = ''
  const client = new MiniMaxClient(config, undefined, async (_url, init) => {
    prompt = JSON.parse(String(init?.body)).messages.map((m: { content: string }) => m.content).join('\n')
    throw new Error('captured author prompt')
  })
  await expect(client.generateStage({ stage: 'jury_deliberation', packet: 'Supplied issue', evidence, previousTurns: '', jurorProfiles: [profile], ...overrides })).rejects.toThrow('captured author prompt')
  return prompt
}

describe('isolated juror stage contract', () => {
  it.each(['beliefTrail', 'deliberationRounds'] as const)('rejects reconstructed %s before it enters the record', field => {
    const response = structuredClone(draft)
    response.jurors[0].beliefTrail = []
    response.jurors[0].deliberationRounds = []
    Object.assign(response.jurors[0], { [field]: draft.jurors[0][field] })
    const request: StageRequest = { stage: 'jury_deliberation', packet: '', previousTurns: '', evidence, jurorProfiles: [profile] }
    expect(() => normalizeStageResult(JSON.stringify(response), request.stage, evidence, false, request)).toThrow('must be empty arrays')
  })

  it.each([false, true])('uses one current-stage response with courtroom protocol %s', async courtroomProtocol => {
    const prompt = await authorPrompt({ courtroomProtocol })
    expect(prompt).toContain('The engine records history; do not reconstruct earlier conversations or simulate other speakers.')
    expect(prompt).toContain('beliefTrail and deliberationRounds must be []')
    expect(prompt).not.toMatch(/four snapshots|with 2 or 3 rounds|not applicable - independent ballot/)
  })

  it('supplies actual own history for a legacy final ballot without enabling legal readiness', async () => {
    const prompt = await authorPrompt({ courtroomProtocol: false, stage: 'juror_ballot', ballotRound: 'final', courtroomAssessments: [{ issueId: 'issue-1', round: 'initial', choice: 'not_guilty', confidence: 60, rationale: 'OWN_INITIAL_REASON_713', usable: true }] })
    expect(prompt).toContain('OWN_INITIAL_REASON_713')
    expect(prompt).toContain('not_guilty')
    expect(prompt).not.toContain('Courtroom claim contract:')
    expect(prompt).not.toContain('not applicable - independent ballot')
  })

  it('keeps the separate aggregate rehearsal contract for a multi-juror request', async () => {
    const prompt = await authorPrompt({ jurorProfiles: [profile, { ...profile, juror: 'Juror 2' }] })
    expect(prompt).toContain('four snapshots')
    expect(prompt).toContain('with 2 or 3 rounds')
  })
})

describe('juror checker boundaries', () => {
  it('distinguishes independent judgment and scoped doubt from historical and source-status claims', () => {
    const prompt = groundingMessages([], evidence, '')[0].content
    expect(prompt).toContain('A final ballot can be independent and still follow an initial assessment')
    expect(prompt).toContain('The supplied accounts do not resolve my doubt is an assessment of sufficiency')
    expect(prompt).toContain('its admitted-status premise still requires supplied admission context')
    expect(prompt).toContain('A recorded interview is not trial testimony merely because it is supplied')
  })

  it('repairs an omitted consistency-warning finding on the same complete draft within the existing limit', async () => {
    const response = { title: '', content: '', citations: [], jurors: [{ juror: 'Juror 1', leaning: 'defence' as const, confidence: 60, rationale: 'I retain doubt.', citations: [], mindChangedBecause: 'I retain doubt.', consistencyWarnings: ['A prior assessment is supplied in my own history.'] }] }
    const before = JSON.stringify(response)
    const units = groundingUnits(response)
    const bodies: string[] = []
    const client = new MiniMaxClient({ ...config, maxRetries: 1 }, undefined, async (_url, init) => {
      bodies.push(String(init?.body))
      const findings = units.filter(unit => bodies.length > 1 || !unit.id.startsWith('juror-warning-')).map(unit => ({ unitId: unit.id, status: 'analysis', citations: [] }))
      return Response.json({ choices: [{ message: { content: JSON.stringify({ findings }) } }] })
    })
    const review = await client.reviewGrounding({ stage: 'juror_ballot', ballotRound: 'final', packet: 'Private final ballot.', evidence, previousTurns: '', courtroomActor: { id: 'juror-01', name: 'Juror 1', roles: ['juror'] }, courtroomAssessments: [{ issueId: 'issue-1', round: 'initial', choice: 'not_guilty', confidence: 60, rationale: 'Initial doubt.', usable: true }] }, response)
    expect(review.status, JSON.stringify(review.errors)).toBe('passed')
    expect(review.verificationRetries).toBe(1)
    expect(bodies).toHaveLength(2)
    expect(bodies.every(body => body.includes('juror-warning-0-0:1'))).toBe(true)
    expect(JSON.stringify(response)).toBe(before)
  })
})
