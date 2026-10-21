import { describe, expect, it } from 'vitest'
import { currentJurorDraft } from '../server/checkerJurorState'
import { parseGroundingReview, type GroundingUnit } from '../server/grounding'
import { MiniMaxClient, normalizeStageResult, type StageRequest } from '../server/minimax'
import type { GroundingRecordEvent } from '../server/groundingRecords'
import { supportedOpeningSource } from '../samples/courtroom-realism/supported-opening'

const peer = { eventId: 'peer-12', type: 'juror_deliberation_turn', actorId: 'juror-12', payload: { contribution: 'I retain reconciliation and knowledge doubts; specific transaction evidence could change my assessment.' } } satisfies GroundingRecordEvent
const other = { ...peer, eventId: 'peer-03', actorId: 'juror-03' }
const initial = { issueId: 'issue-1', round: 'initial', choice: 'not_guilty', confidence: 70, rationale: 'I retain doubt.', usable: true }
const sources = ['E-001', 'E-003'].map(exhibitId => ({ ...supportedOpeningSource, id: exhibitId, exhibitId, text: 'A fictional source records a disputed representation.' }))
const request: StageRequest = { stage: 'jury_deliberation', proceedingPhase: 'deliberation_review', packet: '', previousTurns: '', evidence: sources,
  courtroomActor: { id: 'juror-01', name: 'Juror 1', roles: ['juror'] }, courtroomEvents: [peer, other], courtroomAssessments: [initial], verdictOutcomes: ['guilty', 'not_guilty', 'no_verdict'] }
const influence = 'Juror-12 reinforced my reconciliation concern but supplied no evidence changing my assessment of deprivation or Avery’s knowledge [E-001] [E-003].'
const discussion = 'The visible discussion added no reconciled claimant transaction or knowledge proof, so my initial not-guilty assessment remains stable.'
const conditional = 'My initial not-guilty position remains; reconciled claimant-level evidence resolving these elements could change it.'
function draft(text: string) {
  return normalizeStageResult(JSON.stringify({ title: 'Review', content: text, citations: [], jurors: [{ juror: 'juror-01', leaning: 'defence', confidence: 70, rationale: 'I retain doubt.', citations: [], mindChangedBecause: '', consistencyWarnings: [] }] }), request.stage, [])
}
function check(text: string, options: { status?: string; records?: string[]; history?: typeof initial[]; events?: GroundingRecordEvent[]; actorId?: string } = {}) {
  const result = draft(text)
  return parseGroundingReview(JSON.stringify({ findings: [{ unitId: 'content:1', status: options.status ?? 'supported', explanation: 'Checked against the actual visible discussion and the author’s initial/current assessment.', citations: [], recordCitations: options.records ?? ['peer-12'] }] }),
    [{ id: 'content:1', text }], sources, '', { actorId: options.actorId ?? 'juror-01', assessments: options.history ?? [initial] },
    { packet: '', events: options.events ?? [peer, other], actorRoles: ['juror'], partyRoles: [], actor: { id: 'juror-01' }, stage: request.stage, currentJuror: currentJurorDraft(request, result) })
}

describe('current self-explanation with actual record and history', () => {
  it.each([influence, influence.replace('but supplied no evidence changing my assessment of', 'without adding evidence resolving')])('permits the checked present influence: %s', text => {
    expect(check(text).errors).toEqual([])
    expect(check(text, { history: [] }).status).toBe('passed')
  })
  it('retains cited source metadata on a pure peer-clarification statement', () => {
    const text = 'Juror-12 clarified source genre without adding proof resolving deprivation or Avery’s knowledge [E-003] [E-001].'
    const result = check(text)
    expect(result.status).toBe('passed')
    expect(result.findings[0].text).toBe(text)
  })
  it('does not create a missing exhibit by stripping terminal metadata for classification', () => {
    expect(check(influence.replace('E-001', 'E-999')).status).toBe('failed')
  })
  it.each(['supported', 'analysis'])('checks the entire visible discussion for %s', status => {
    expect(check(discussion, { status, records: ['peer-12', 'peer-03'] }).status).toBe('passed')
    expect(check(discussion, { status, records: ['peer-12'] }).status).toBe('failed')
    expect(check(discussion, { status, records: [] }).status).toBe('failed')
    expect(check(discussion, { status, records: [], events: [] }).status).toBe('failed')
  })
  it.each(['supported', 'analysis'])('accepts a verified stable position and a prospective condition for %s', status => {
    expect(check(conditional, { status, records: [] }).status).toBe('passed')
    for (const history of [[], [{ ...initial, choice: 'guilty' }], [{ ...initial, usable: false }], [initial, initial]]) {
      expect(check(conditional, { status, records: [], history }).status).toBe('failed')
      expect(check(discussion, { status, records: ['peer-12', 'peer-03'], history }).status).toBe('failed')
    }
    expect(check(conditional, { status, actorId: 'juror-02' }).status).toBe('failed')
  })
  it.each(['unsupported', 'contradicted'])('preserves a semantic %s result', status => {
    for (const text of [influence, discussion, conditional]) expect(check(text, { status, records: ['peer-12', 'peer-03'] }).status).toBe('failed')
  })
  it.each([
    influence.replace('reinforced', 'previously reinforced'),
    influence.replace('changing my assessment of deprivation or Avery’s knowledge', 'at all'),
    influence.replace('my reconciliation concern', 'my initial reconciliation concern'),
    conditional.replace('could change it', 'changed my earlier position'),
    conditional.replace('could change it', 'could change it because Avery received cash'),
    discussion.replace('The visible discussion', 'All disclosure'),
    discussion.replace('knowledge proof', 'knowledge proof because the witness lied'),
  ])('does not exempt a different history or independent factual claim: %s', text => {
    expect(check(text, { records: ['peer-12', 'peer-03'] }).status).toBe('failed')
  })
  it('does not use a failed or ambiguous contribution for whole-discussion scope', () => {
    expect(check(discussion, { records: ['peer-12', 'peer-03'], events: [peer, peer, other] }).status).toBe('failed')
    expect(check(discussion, { records: ['peer-12', 'peer-03'], events: [peer, { ...other, payload: { ...other.payload, withheld: true } }] }).status).toBe('failed')
  })
})

describe('bounded re-review of present influence', () => {
  it.each([false, true])('requests a new judgment and preserves a repeated rejection=%s', async repeat => {
    const sent: string[] = []
    const client = new MiniMaxClient({ provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1', model: 'fixture', timeoutMs: 1000, maxRetries: 1 }, undefined, async (_url, init) => {
      const prompt = JSON.parse(String(init?.body)).messages[1].content; sent.push(prompt)
      const units = JSON.parse(prompt.split('Draft units to check:\n')[1]) as GroundingUnit[]
      return Response.json({ choices: [{ message: { content: JSON.stringify({ findings: units.map(unit => ({ unitId: unit.id,
        status: unit.id === 'content:1' && (sent.length === 1 || repeat) ? 'unsupported' : 'analysis',
        explanation: unit.id === 'content:1' ? 'The peer does not establish that it reinforced this author’s concern; those historical and internal-state claims require matching support.' : 'Current opinion.',
        citations: [], recordCitations: unit.id === 'content:1' ? ['peer-12'] : [],
      })) }) } }] })
    })
    const result = await client.reviewGrounding(request, draft(influence))
    expect(sent).toHaveLength(2)
    expect(sent[1]).toContain('checker current-influence scope mismatch')
    expect(result.status).toBe(repeat ? 'failed' : 'passed')
    expect(result.findings.find(f => f.unitId === 'content:1')?.text).toBe(influence)
  })
})
