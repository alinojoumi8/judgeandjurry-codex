import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { groundingUnits, parseGroundingReview } from '../server/grounding'
import type { StageRequest } from '../server/minimax'
import type { StageResult } from '../server/types'

const capture = JSON.parse(readFileSync(new URL('../docs/qa/jury/v129-possible-contradict-control-capture.json', import.meta.url), 'utf8'))
const request = capture.control.request as StageRequest
const check = (text: string, q = request, status = 'unsupported', ballot = false) => {
  const result = { title: '', content: text, citations: [], jurors: [] } as StageResult
  const units = groundingUnits(result)
  if (ballot) units.push({ id: 'ballot:whole', kind: 'ballot_consistency', text })
  return parseGroundingReview(JSON.stringify({ findings: units.map(unit => ({ unitId: unit.id, status,
    explanation: 'The captured checker incorrectly requires an established contradiction.', citations: [] })) }),
  units, q.evidence, q.groundingContext, undefined,
  { packet: q.packet, events: q.courtroomEvents ?? [], actorRoles: q.courtroomActor?.roles ?? [], partyRoles: q.approvedPartyRoles ?? [], stage: q.stage }).status
}

describe('tentative source comparisons preserve their modal scope', () => {
  it.each(['unsupported', 'contradicted'])('corrects the captured %s rejection', status => {
    expect(check(capture.control.draft.content, request, status)).toBe('passed')
  })
  it.each(['may', 'could', 'might'])('allows a complete %s comparison without asserting incompatibility', modal => {
    expect(check(`The accounts ${modal} contradict on receipt.`)).toBe('passed')
  })
  it('binds renamed actual participants rather than fixture identities', () => {
    const q = JSON.parse(JSON.stringify(request).replaceAll('Morgan', 'Avery').replaceAll('Ellis', 'Nox').replaceAll('Mira', 'Vera').replaceAll('Tavi', 'Sol')) as StageRequest
    expect(check('The accounts may contradict on receipt.', q)).toBe('passed')
  })
  it.each([
    'The accounts contradict on receipt.',
    'The accounts may contradict because Tavi saw the departure.',
    'The accounts may contradict on receipt. No handover occurred.',
    'The accounts may contradict on receipt, proving Ellis guilty.',
  ])('does not clear additional or definite claims: %s', text => expect(check(text)).toBe('failed'))
  it('requires two actual accounts', () => {
    expect(check('The accounts may contradict on receipt.', { ...request, evidence: request.evidence.slice(0, 1) })).toBe('failed')
    expect(check('The accounts may contradict on receipt.', { ...request, evidence: request.evidence.slice(0, 1) }, 'analysis')).toBe('failed')
  })
  it('requires the actual issue participants', () => {
    expect(check('The accounts may contradict on receipt.', { ...request, packet: request.packet.replaceAll('Ellis received', 'Nox received') })).toBe('failed')
    expect(check('The accounts may contradict on receipt.', { ...request, packet: request.packet.replaceAll('Ellis received', 'Nox received') }, 'analysis')).toBe('failed')
  })
  it('requires permission to assess both actual accounts', () => {
    const q = { ...request, groundingContext: request.groundingContext!.replaceAll('Assess the fictional condition using the attributed disputed account.', 'Accurately attribute the account only; not proof of receipt.') }
    expect(check('The accounts may contradict on receipt.', q)).toBe('failed')
    expect(check('The accounts may contradict on receipt.', q, 'analysis')).toBe('failed')
  })
  it('does not promote a failed whole-ballot consistency judgment', () => {
    expect(check('The accounts may contradict on receipt.', request, 'unsupported', true)).toBe('failed')
  })
})

describe('actual opposing accounts can leave the current juror uncertain', () => {
  const actual = JSON.parse(readFileSync(new URL('../docs/qa/jury/v129-actual-denial-control-capture.json', import.meta.url), 'utf8'))
  const q = actual.control.request as StageRequest
  const content = actual.control.draft.content as string
  it.each(['unsupported', 'contradicted'])('preserves the captured current assessment despite checker %s', status => {
    expect(check(content, q, status)).toBe('passed')
  })
  it('binds the actual renamed handover and sole element', () => {
    const renamed = JSON.parse(JSON.stringify(q).replaceAll('Morgan', 'Avery').replaceAll('Ellis', 'Nox')) as StageRequest
    expect(check(content, renamed)).toBe('passed')
  })
  it.each(['I did not see a handover.', 'No handover occurred at noon.', 'If no handover occurred, I would be uncertain.'])('does not invent definite contradiction from %s', body => {
    expect(check(content, { ...q, evidence: q.evidence.map(e => e.exhibitId === 'E-002' ? { ...e, text: `Tavi states: ${body}` } : e) })).toBe('failed')
  })
  it('does not clear a rule about every decision-maker', () => {
    expect(check('The genuine contradiction prevents any jury from reaching a firm conclusion.', q)).toBe('failed')
  })
  it('does not clear an added allegation or failed whole ballot', () => {
    expect(check(content + ' Rowan concealed cash.', q)).toBe('failed')
    expect(check(content, q, 'unsupported', true)).toBe('failed')
  })
  it('requires current assessment permission and task', () => {
    expect(check(content, { ...q, stage: 'witness_answer', courtroomActor: { ...q.courtroomActor!, roles: ['witness'] } })).toBe('failed')
    expect(check(content, { ...q, groundingContext: q.groundingContext!.replaceAll('Assess the fictional condition using the attributed disputed account.', 'Attribute the account only.') })).toBe('failed')
  })
})

describe('a personal non-observation does not deny handover occurrence', () => {
  const actual = JSON.parse(readFileSync(new URL('../docs/qa/jury/v129-nonglobal-control-capture.json', import.meta.url), 'utf8'))
  const q = actual.control.request as StageRequest
  const content = actual.control.draft.content as string
  it.each(['unsupported', 'contradicted'])('preserves the actual qualified comparison despite %s', status => {
    expect(check(content, q, status)).toBe('passed')
  })
  it('keeps an actual global denial opposed to the actual positive handover', () => {
    const global = { ...q, evidence: q.evidence.map(e => e.exhibitId === 'E-002' ? { ...e, text: 'Tavi states: No handover occurred.' } : e) }
    expect(check(content, global, 'analysis')).toBe('failed')
  })
})
