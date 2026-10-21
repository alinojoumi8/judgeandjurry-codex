import { describe, expect, it } from 'vitest'
import { parseGroundingReview } from '../server/grounding'
import { MiniMaxClient, type StageRequest } from '../server/minimax'
import type { JurorProfile } from '../server/types'
import { supportedOpeningSource } from '../samples/courtroom-realism/supported-opening'

const peer = { eventId: 'visible-peer', type: 'juror_deliberation_turn', actorId: 'juror-02', payload: { contribution: 'Factual conclusions require careful source support.', withheld: false } }
function review(text: string, records: string[] = [], events = [peer]) {
  return parseGroundingReview(JSON.stringify({ findings: [{ unitId: 'content:1', status: 'analysis', explanation: 'Current response to discussion.', citations: [], recordCitations: records }] }), [{ id: 'content:1', text }], [], '', undefined,
    { packet: '', events, actorRoles: ['juror'], partyRoles: [], actor: { id: 'juror-01' }, stage: 'jury_deliberation' })
}

describe('juror references bind to visible contributions', () => {
  it('rejects an invented peer even when the checker calls it analysis', () => {
    expect(review('I agree with juror-0 that factual conclusions require careful source support.').status).toBe('failed')
  })

  it('requires the actual record locator for agreement with a real peer', () => {
    expect(review('I agree with juror-02 that factual conclusions require careful source support.').status).toBe('failed')
    expect(review('I agree with juror-02 that factual conclusions require careful source support.', ['visible-peer']).status).toBe('passed')
  })

  it('does not borrow another peer contribution', () => {
    expect(review('I disagree with juror-03 that factual conclusions require careful source support.', ['visible-peer']).status).toBe('failed')
  })

  it('rejects a withheld contribution as a source of a peer argument', () => {
    expect(review('I agree with juror-02 that factual conclusions require careful source support.', ['visible-peer'], [{ ...peer, payload: { ...peer.payload, withheld: true } }]).status).toBe('failed')
  })

  it('accepts actual participant IDs without assuming a particular panel size', () => {
    expect(review('I agree with juror-99 that factual conclusions require careful source support.', ['visible-peer'], [{ ...peer, actorId: 'juror-99' }]).status).toBe('passed')
  })

  it('preserves an own assessment with no invented peer', () => {
    expect(review('I assess the supplied record independently.', [], []).status).toBe('passed')
  })

  it('gives isolated authors only usable peer references and explains audit labels', async () => {
    let prompt = ''
    const client = new MiniMaxClient({ provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1', model: 'fixture', timeoutMs: 1000, maxRetries: 0 }, undefined, async (_url, init) => {
      prompt = JSON.parse(String(init?.body)).messages.map((m: { content: string }) => m.content).join('\n')
      throw new Error('captured prompt')
    })
    const request: StageRequest = { stage: 'jury_deliberation', packet: 'Proposed issue for this exercise', previousTurns: '', evidence: [],
      courtroomActor: { id: 'juror-01', name: 'Juror 1', roles: ['juror'] }, courtroomEvents: [peer, { ...peer, eventId: 'withheld-peer', actorId: 'juror-03', payload: { ...peer.payload, withheld: true } }],
      jurorProfiles: [{ juror: 'juror-01', skepticismLevel: 50, burdenSensitivity: 60 } as JurorProfile],
    }
    await expect(client.generateStage(request)).rejects.toThrow('captured prompt')
    expect(prompt).toContain('Visible peer references: [{"actorId":"juror-02","eventId":"visible-peer"}]')
    expect(prompt).toContain('Audit unit IDs identify fields, not participants.')
    expect(prompt).toContain('proposed issue instructions do not establish the contents of an operative charging document')
  })
})

describe('peer agreement with a separately attributed source quotation', () => {
  const source = { ...supportedOpeningSource, exhibitId: 'E-001', text: 'The schedule labels Pending deposits as not reconciled.' }
  const text = 'I agree with juror-02: E-001 records "Pending deposits" as "not reconciled", so I retain doubt about account ownership.'
  const check = (draft = text, citations = [{ exhibitId: 'E-001', paragraph: 1 }], records = ['visible-peer']) =>
    parseGroundingReview(JSON.stringify({ findings: [{ unitId: 'content:1', status: 'supported', explanation: 'The visible peer and source support their respective attributions.', citations, recordCitations: records }] }), [{ id: 'content:1', text: draft }], [source], '', undefined,
      { packet: '', events: [peer], actorRoles: ['juror'], partyRoles: [], actor: { id: 'juror-01' }, stage: 'jury_deliberation' })

  it('checks source quotations against the named source, separately from the peer reference', () => {
    expect(check().status).toBe('passed')
  })
  it.each([';', ', and', ' that'])('keeps the source binding with the %s connector', connector => {
    expect(check(text.replace(': E-001', `${connector} E-001`)).status).toBe('passed')
  })
  it('can also verify a separate exact quotation from the peer', () => {
    expect(check(text + ' Juror-02 said "Factual conclusions require careful source support."').status).toBe('passed')
  })
  it('still rejects an invented peer', () => {
    expect(check(text.replace('juror-02', 'juror-0')).status).toBe('failed')
  })
  it('still requires a matching peer event', () => {
    expect(check(text, undefined, []).status).toBe('failed')
  })
  it('does not accept altered source words', () => {
    expect(check(text.replace('not reconciled', 'fully reconciled')).status).toBe('failed')
  })
  it('does not accept an altered peer quotation alongside a valid source quotation', () => {
    expect(check(text + ' Juror-02 said "Factual conclusions require careless source support."').status).toBe('failed')
  })
  it('does not use a peer citation to replace required factual source support', () => {
    expect(check(text, []).status).toBe('failed')
  })
  it('does not borrow a quotation from the wrong exhibit', () => {
    expect(check(text.replace('E-001', 'E-002')).status).toBe('failed')
  })
})
