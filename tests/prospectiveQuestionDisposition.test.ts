import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { groundingUnits, parseGroundingReview } from '../server/grounding'

const capture = JSON.parse(readFileSync('docs/qa/jury/v139-full-control-judge-ruling-positive-capture.json', 'utf8'))
function check(request = structuredClone(capture.request), text = capture.draft.content, status = 'unsupported') {
  const units = groundingUnits({ ...capture.draft, content: text })
  return parseGroundingReview(JSON.stringify({ findings: units.map(unit => ({ unitId: unit.id, status, explanation: 'Captured proposed question-disposition judgment.', citations: [] })) }), units,
    request.evidence, request.groundingContext, undefined, {
      packet: request.packet, events: request.courtroomEvents, actorRoles: request.courtroomActor.roles,
      partyRoles: request.approvedPartyRoles, actor: request.courtroomActor, stage: request.stage,
    }).status
}

describe('prospective disposition of the actual prohibited question', () => {
  it.each(['unsupported', 'contradicted', 'analysis'])('preserves the complete recommendation under checker %s', status => {
    expect(check(undefined, undefined, status)).toBe('passed')
  })
  it('does not require a completed ruling to recommend one', () => {
    expect(capture.request.courtroomEvents.every((event: any) => event.type !== 'objection_ruling')).toBe(true)
    expect(check()).toBe('passed')
  })
  it.each(['unsupported', 'analysis'])('requires the supplied prohibition under checker %s', status => {
    const request = structuredClone(capture.request); request.packet = request.packet.replace('Such questions are prohibited;', 'Such questions are not prohibited;')
    expect(check(request, undefined, status)).toBe('failed')
  })
  it.each(['unsupported', 'analysis'])('requires the actual question to assume contents under checker %s', status => {
    const request = structuredClone(capture.request); request.courtroomEvents[0].payload.text = 'Do you know the contents?'
    expect(check(request, undefined, status)).toBe('failed')
  })
  it('requires an actual question', () => {
    expect(check({ ...capture.request, courtroomEvents: [] }, undefined, 'analysis')).toBe('failed')
  })
  it('does not turn a source account into a procedural instruction', () => {
    expect(check({ ...capture.request, packet: '' }, undefined, 'analysis')).toBe('failed')
  })
  it('requires the actual account to retain the unknown-contents qualification', () => {
    const request = structuredClone(capture.request); request.evidence[0].text = request.evidence[0].text.replace('I do not know what the envelope contained.', 'The envelope contained cash.')
    expect(check(request, undefined, 'analysis')).toBe('failed')
  })
  it('requires the instruction to name the actual account speaker', () => {
    const request = structuredClone(capture.request); request.packet = request.packet.replace("Mira's account", "Tavi's account")
    expect(check(request, undefined, 'analysis')).toBe('failed')
  })
  it('requires an actual permitted account', () => {
    expect(check({ ...capture.request, evidence: [] }, undefined, 'analysis')).toBe('failed')
    expect(check({ ...capture.request, groundingContext: 'E-101: excluded; no use permitted.' }, undefined, 'analysis')).toBe('failed')
  })
  it('does not clear an unsupplied past ruling', () => {
    expect(check(undefined, 'The objection was sustained and the question was struck.', 'unsupported')).toBe('failed')
  })
  it('does not clear source exclusion or an added factual premise', () => {
    expect(check(undefined, capture.draft.content + ' The source is excluded.', 'unsupported')).toBe('failed')
    expect(check(undefined, capture.draft.content + ' Rowan concealed cash.', 'unsupported')).toBe('failed')
  })
})
