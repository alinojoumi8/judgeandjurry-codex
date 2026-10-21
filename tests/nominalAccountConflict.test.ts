import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { groundingUnits, parseGroundingReview } from '../server/grounding'
import { MiniMaxClient } from '../server/minimax'

const capture = JSON.parse(readFileSync('docs/qa/jury/v168-captured-nominal-conflict.json', 'utf8'))
type Control = { id: string; expected: string; request: any; draft: any }
const advocacy = JSON.parse(readFileSync('docs/qa/jury/v168-preserved-advocacy-controls.json', 'utf8')) as Control[]
const recordControl = JSON.parse(readFileSync('docs/qa/jury/v168-preserved-record-control.json', 'utf8')) as Control
function checkControl(control: Control, content?: string) {
  const q = control.request, draft = structuredClone(control.draft)
  if (content) draft.content = content
  const units = groundingUnits(draft)
  return parseGroundingReview(JSON.stringify({ findings: units.map(unit => ({ unitId: unit.id, status: 'analysis', explanation: 'Current argument or assessment.', citations: [], recordCitations: [] })) }),
    units, q.evidence, q.groundingContext,
    { actorId: q.courtroomActor.id, assessments: q.courtroomAssessments ?? [], profile: q.jurorProfiles?.find((profile: { juror: string }) => profile.juror === q.courtroomActor.id) },
    { packet: q.packet, events: q.courtroomEvents, actorRoles: q.courtroomActor.roles, partyRoles: q.approvedPartyRoles,
      actor: q.courtroomActor, stage: q.stage, courtroomState: q.courtroomState }).status
}
function check(text: string, field = 'content', explicitDenial = false) {
  const q = structuredClone(capture.request), draft = structuredClone(capture.result)
  draft.title = ''
  draft.content = draft.jurors[0].rationale = 'I retain reasonable doubt on the supplied record.'
  draft.jurors[0].mindChangedBecause = 'This is my initial assessment.'
  if (field === 'content' || field === 'title') draft[field] = text
  else draft.jurors[0][field] = text
  if (explicitDenial) q.evidence.find((item: { exhibitId: string }) => item.exhibitId === 'E-002').text = 'Tavi states: No handover occurred.'
  const units = groundingUnits(draft)
  return parseGroundingReview(JSON.stringify({ findings: units.map(unit => ({ unitId: unit.id, status: 'analysis', explanation: 'Current source assessment.', citations: [], recordCitations: [] })) }),
    units, q.evidence, q.groundingContext,
    { actorId: q.courtroomActor.id, assessments: q.courtroomAssessments, profile: q.jurorProfiles[0] },
    { packet: q.packet, events: q.courtroomEvents, actorRoles: q.courtroomActor.roles, partyRoles: q.approvedPartyRoles,
      actor: q.courtroomActor, stage: q.stage, ballotRound: q.ballotRound }).status
}

describe('nominal account conflict does not invent incompatible events', () => {
  it('withholds the actual new false acceptance despite accurate neighboring quotations', async () => {
    const client = new MiniMaxClient({ provider: 'minimax', apiKey: 'fictional', baseUrl: 'https://fixture.invalid/v1',
      model: 'fixture', timeoutMs: 2000, maxRetries: 0 }, undefined,
    async () => Response.json({ choices: [{ message: { content: capture.checkerContent } }] }))
    expect((await client.reviewGrounding(capture.request, capture.result)).status).toBe('failed')
  })
  it('retains the valid live rejection of the newly mislabeled disputed-comparison control', async () => {
    const c = JSON.parse(readFileSync('docs/qa/jury/v169-captured-qualified-comparison.json', 'utf8'))
    const client = new MiniMaxClient({ provider: 'minimax', apiKey: 'fictional', baseUrl: 'https://fixture.invalid/v1',
      model: 'fixture', timeoutMs: 2000, maxRetries: 0 }, undefined,
    async () => Response.json({ choices: [{ message: { content: c.checkerContent } }] }))
    expect((await client.reviewGrounding(c.request, c.result)).status).toBe('failed')
  })
  it.each([
    'I find the conflicting accounts leave the condition unproved beyond a reasonable doubt.',
    'My current doubt rests on these conflicting accounts.',
    'I rely on conflicting attributed accounts in assessing receipt.',
    'The conflicting disputed accounts leave me doubtful.',
    'I cannot resolve these conflicting sources on receipt.',
    'No supplied timing makes those accounts incompatible, but these are conflicting accounts.',
  ])('does not clear an adopted factual comparison as analysis: %s', text => {
    expect(check(text)).toBe('failed')
  })
  it.each(['title', 'content', 'rationale', 'mindChangedBecause'])('checks the nominal comparison independently in %s', field => {
    expect(check('These are conflicting accounts on receipt.', field)).toBe('failed')
  })
  it.each([
    'These are possibly conflicting accounts.',
    'These are potentially conflicting accounts.',
    'No conflicting accounts are supplied.',
    'Are these conflicting accounts?',
    'It would be incorrect to call these conflicting accounts.',
    'Do not call these conflicting accounts.',
    'These accounts remain disputed; I retain reasonable doubt.',
    'No supplied timing makes those accounts incompatible.',
    'The rule does not say conflicting accounts cannot meet proof beyond reasonable doubt.',
  ])('preserves qualification, correction, inquiry, disputed status or current doubt: %s', text => {
    expect(check(text)).toBe('passed')
  })
  it('preserves a real conflicting event proposition in the actual source set', () => {
    expect(check('These are conflicting accounts on receipt.', 'content', true)).toBe('passed')
  })
  it.each(advocacy)('preserves the actual prior advocacy control $id', control => {
    expect(checkControl(control)).toBe(control.expected)
  })
  it('preserves the actual prior attributed and record-bounded juror assessment', () => {
    expect(checkControl(recordControl)).toBe(recordControl.expected)
  })
  it('does not exempt the existing direct-conflict predicate in an advocate task', () => {
    expect(checkControl(advocacy[0], 'The accounts are conflicting directly on receipt.')).toBe('failed')
  })
  it('keeps explicitly record-bounded assessment and independent account credit available', () => {
    expect(check('On this supplied record, the conflicting attributed accounts require assessment. I give Mira greater weight after assessing the source accounts.')).toBe('passed')
  })
  it('does not let a record-bounded label exempt a separate direct contradiction claim', () => {
    expect(check('On this supplied record, the conflicting attributed accounts directly contradict on receipt.')).toBe('failed')
  })
})
