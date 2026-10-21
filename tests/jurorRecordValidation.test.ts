import { describe, expect, it } from 'vitest'
import { courtroomAuditEvents, parseGroundingReview } from '../server/grounding'
import { MiniMaxClient, type StageRequest } from '../server/minimax'
import type { TrialEvent } from '../server/trialEngineTypes'

const peer = { eventId: '3aa2e496-7194-443f-bc8d-f0fa7209b346', type: 'juror_deliberation_turn', actorId: 'juror-04', payload: { contribution: 'I retain doubt. Knowledge and matched deprivation remain unresolved; the accounting classifications require interpretation.' } }
const instruction = { eventId: 'instruction-1', type: 'judicial_instruction', actorId: 'judge-1', payload: { text: 'Every verdict-sheet item requires 12 valid unanimous final ballots.', issueInstructions: [{ issueId: 'exercise-1', elements: ['A dishonest act', 'Deprivation'], outcomes: ['guilty', 'not_guilty', 'no_verdict'] }], sourceNotice: 'Proposed exercise instructions; lawyer review required.' } }
const setup = { packet: '', events: [peer, instruction], actorRoles: ['juror'], partyRoles: [], actor: { id: 'juror-01' }, stage: 'jury_deliberation' }
function check(text: string, records = [peer.eventId], status = 'supported', events = setup.events) {
  return parseGroundingReview(JSON.stringify({ findings: [{ unitId: 'content:1', status, explanation: 'An accurate attribution of the supplied assessment or instruction.', citations: [], recordCitations: records }] }), [{ id: 'content:1', text }], [], '', undefined, { ...setup, events })
}

describe('typed visible record references', () => {
  it.each([
    'I agree with juror-04’s assessment that the Crown has not met the charge beyond a reasonable doubt.',
    'I agree with juror-04’s focus on knowledge and matched deprivation.',
    'I agree with juror-04’s exhibit-specific concern.',
    'Juror-04’s focus on accounting classifications reinforced my doubt.',
  ])('supports peer assessment attribution without demanding an exhibit: %s', text => {
    expect(check(text).errors).toEqual([])
  })
  it.each([
    'I agree with juror-04 that the accused received $5,000.',
    'I agree with juror-04’s concern, and E-001 proves receipt.',
    'I agree with juror-04’s assessment; the accused transferred the funds.',
    'Juror-04’s concern proves that no handover occurred.',
    'Juror-04’s focus reinforced my doubt, and the accused transferred the funds.',
  ])('does not use a peer assessment as factual proof: %s', text => {
    expect(check(text).status).toBe('failed')
  })
  it('resolves a supplied short reference to the exact stable event ID and original words', () => {
    const result = check('I agree with juror-04’s concern.', ['record:1'])
    expect(result.status).toBe('passed')
    expect(result.findings[0].recordCitations).toEqual([{ eventId: peer.eventId, actorId: peer.actorId, quote: peer.payload.contribution }])
  })
  it('never fuzzy-corrects a malformed or unknown ID', () => {
    for (const id of [peer.eventId.replace('f0fa', 'd0fa'), 'record:999']) expect(check('I agree with juror-04’s concern.', [id]).status).toBe('failed')
  })
  it('rejects ambiguous IDs rather than choosing one record', () => {
    expect(check('I agree with juror-04’s concern.', [peer.eventId], 'supported', [peer, { ...peer, actorId: 'juror-05' }]).status).toBe('failed')
    expect(check('I agree with juror-04’s concern.', ['record:1'], 'supported', [peer, { ...peer, eventId: 'record:1', actorId: 'juror-05' }]).status).toBe('failed')
  })
  it('rejects a real event belonging to the wrong peer', () => {
    expect(check('I agree with juror-03’s concern.', ['record:1']).status).toBe('failed')
  })
  it.each([
    { ...peer.payload, withheld: true },
    { contribution: 'No valid model contribution was available for this turn.' },
    { contribution: '' },
  ])('does not accept an unusable peer contribution', payload => {
    expect(check('I agree with juror-04’s concern.', [peer.eventId], 'supported', [{ ...peer, payload }]).status).toBe('failed')
  })
  it('accepts a visible judicial instruction as procedural support', () => {
    const result = check('A final unanimous verdict requires all 12 jurors.', [instruction.eventId], 'analysis')
    expect(result.status).toBe('passed')
    expect(result.findings[0].recordCitations?.[0]).toMatchObject({ eventId: instruction.eventId, quote: instruction.payload.text })
  })
  it('verifies quoted instruction words against the selected instruction', () => {
    expect(check('The instruction states "Every verdict-sheet item requires 12 valid unanimous final ballots."', [instruction.eventId], 'analysis').status).toBe('passed')
    expect(check('The instruction states "Every verdict-sheet item requires 11 valid unanimous final ballots."', [instruction.eventId], 'analysis').status).toBe('failed')
  })
  it('does not let an instruction replace an exhibit or a peer contribution', () => {
    expect(check('The accused received $5,000.', [instruction.eventId]).status).toBe('failed')
    expect(check('I agree with juror-04’s concern.', [instruction.eventId], 'analysis').status).toBe('failed')
  })
  it('does not promote a checker rejection merely because a real reference exists', () => {
    expect(check('I agree with juror-04’s concern.', [peer.eventId], 'unsupported').status).toBe('failed')
  })
  it('projects approved exercise instructions only from instruction events', () => {
    const project = (event: typeof instruction) => courtroomAuditEvents([{ ...event, id: event.eventId, visibleTo: ['public'] } as unknown as TrialEvent])[0]
    expect(project(instruction).payload).toMatchObject({ issueInstructions: instruction.payload.issueInstructions, sourceNotice: instruction.payload.sourceNotice })
    expect(project({ ...instruction, type: 'public_submission' }).payload).not.toHaveProperty('issueInstructions')
  })
  it('supplies exact short references to the checker and omits placeholders from author hints', async () => {
    const sent: string[] = []
    const client = new MiniMaxClient({ provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1', model: 'fixture', timeoutMs: 1000, maxRetries: 0 }, undefined, async (_url, init) => {
      sent.push(JSON.parse(String(init?.body)).messages.map((m: { content: string }) => m.content).join('\n'))
      throw new Error('captured')
    })
    const request: StageRequest = { stage: 'jury_deliberation', packet: '', previousTurns: '', evidence: [], courtroomActor: { ...setup.actor, name: 'Juror 1', roles: ['juror'] }, courtroomEvents: [peer, instruction, { ...peer, eventId: 'failed', actorId: 'juror-05', payload: { contribution: 'No valid model contribution was available for this turn.' } }], jurorProfiles: [{ juror: 'juror-01' } as never] }
    await expect(client.generateStage(request)).rejects.toThrow('captured')
    const hint = sent[0].split('\n').find(line => line.startsWith('Visible peer references:'))!
    expect(hint).toContain(peer.eventId)
    expect(hint).not.toContain('"failed"')
    await expect(client.reviewGrounding(request, { title: '', content: 'I retain doubt.', citations: [], jurors: [] })).rejects.toThrow('captured')
    expect(sent[1]).toContain('"reference":"record:1"')
    expect(sent[1]).toContain('"type":"judicial_instruction"')
    expect(sent[1]).toContain('issueInstructions')
  })
})
