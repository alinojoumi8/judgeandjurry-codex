import { describe, expect, it } from 'vitest'
import { projectParticipantMemory } from '../server/actorMemory'
import { assembleActorContext } from '../server/actorContext'
import type { EvidenceItem } from '../server/types'
import type { TrialEvent, EvidenceUse } from '../server/trialEngineTypes'

const evidence = [{ id: 'source', exhibitId: 'E-001', text: 'Early material fact. SECRET', summary: 'SECRET', name: 'record' }] as EvidenceItem[]
const use = { evidenceId: 'source', status: 'admitted', purposes: [], redactions: [], hiddenFrom: [], note: '' } as unknown as EvidenceUse
const event = (sequence: number, type: string, payload: Record<string, unknown>, visibleTo = ['public'], sourceRefs: TrialEvent['sourceRefs'] = []): TrialEvent => ({
  id: `event-${sequence}`, trialRunId: 'run', sequence, phase: 'evidence', type, payload, visibleTo, sourceRefs, createdAt: '2026-10-03',
})
const input = (events: TrialEvent[], role = 'juror' as const) => ({ runId: 'run', actorId: 'juror-01', roles: [role], events, evidence, uses: [use], throughSequence: 100, protocol: true, approvedStatementRefs: [] })

describe('participant memory and context', () => {
  it('retains early material and labels submissions separately after a long hearing', () => {
    const events = [event(1, 'witness_answer', { text: 'EARLY_FACT' }, ['public'], [{ evidenceId: 'source', attribution: 'source' }]), event(2, 'public_submission', { text: 'ALLEGATION' }), event(3, 'phase_started', { filler: 'x'.repeat(35_000) })]
    const memory = projectParticipantMemory(input(events))
    expect(memory.records.find(r => r.eventId === 'event-1')?.kind).toBe('testimony')
    const context = assembleActorContext(input(events), 60_000)
    expect(context.previousTurns).toContain('EARLY_FACT')
    expect(context.previousTurns).toContain('submission')
    expect(context.manifest.omittedEventIds).toEqual([])
    expect(projectParticipantMemory(input(events))).toEqual(memory)
  })
  it('never includes private, future, jury-out or system audit material', () => {
    const events = [event(1, 'public_submission', { text: 'PRIVATE_SECRET' }, ['role:defence']), event(2, 'jury_departed', {}), event(3, 'witness_answer', { text: 'JURY_OUT_SECRET' }), event(4, 'jury_returned', {}), event(5, 'witness_answer', { text: 'VISIBLE' }), event(101, 'witness_answer', { text: 'FUTURE_SECRET' }), event(6, 'audit', { text: 'AUDIT_SECRET' }, ['role:system'])]
    const result = assembleActorContext(input(events))
    expect(result.previousTurns).toContain('VISIBLE')
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_SECRET|JURY_OUT_SECRET|FUTURE_SECRET|AUDIT_SECRET/)
  })
  it('preserves heard references while invalidating excluded or struck usable content', () => {
    const events = [event(1, 'witness_answer', { text: 'NOW_EXCLUDED' }, ['public'], [{ evidenceId: 'source', attribution: 'source' }]), event(2, 'witness_answer', { text: 'STRUCK_SECRET' }), event(3, 'answer_struck', { answerEventId: 'event-2' })]
    const result = assembleActorContext({ ...input(events), uses: [{ ...use, status: 'excluded' }] })
    expect(result.memory.heardEventIds).toContain('event-1')
    expect(result.memory.invalidatedEventIds).toEqual(['event-1', 'event-2'])
    expect(JSON.stringify(result)).not.toMatch(/NOW_EXCLUDED|STRUCK_SECRET|Early material fact/)
    expect(result.evidence).toEqual([])
  })
  it('redacts summaries and old event quotes and applies purpose restrictions', () => {
    const result = assembleActorContext({ ...input([event(1, 'witness_answer', { text: 'SECRET' }, ['public'], [{ evidenceId: 'source', quote: 'SECRET', attribution: 'source' }])]), uses: [{ ...use, status: 'redacted', redactions: ['SECRET'], purposes: ['notice only'] }] })
    expect(JSON.stringify(result)).not.toContain('SECRET')
    expect(result.memory.usableSources[0].purposes).toEqual(['notice only'])
  })
  it('witness context contains only its approved passages and addressed questions', () => {
    const result = assembleActorContext({ ...input([event(1, 'witness_answer', { witnessId: 'other', text: 'OTHER_ACCOUNT' }), event(2, 'witness_question', { witnessId: 'w1', question: 'Question' })]), actorId: 'w1', roles: ['witness'], approvedStatementRefs: [{ evidenceId: 'source', quote: 'Early material fact.', attribution: 'source' }] })
    expect(result.previousTurns).toContain('Question')
    expect(JSON.stringify(result)).not.toMatch(/OTHER_ACCOUNT|SECRET/)
    expect(result.evidence[0].text).toBe('Early material fact.')
  })
  it('requires presentation to the jury rather than merely admission', () => {
    expect(assembleActorContext(input([])).evidence).toEqual([])
    expect(assembleActorContext(input([event(1, 'exhibit_presented', {}, ['role:juror'], [{ evidenceId: 'source', attribution: 'source' }])])).evidence).toHaveLength(1)
  })
  it('fails explicitly when authorised material cannot fit the budget', () => {
    expect(() => assembleActorContext(input([event(1, 'witness_answer', { text: 'x'.repeat(1000) })]), 100)).toThrow(/context.*budget/i)
  })
  it('delivers queued instructions only after jury return and invalidates dependent actor assessments', () => {
    const events = [event(1, 'jury_departed', {}), event(2, 'limiting_instruction', { text: 'NOTICE_ONLY' })]
    expect(assembleActorContext(input(events)).previousTurns).not.toContain('NOTICE_ONLY')
    expect(assembleActorContext(input([...events, event(3, 'jury_returned', {})])).previousTurns).toContain('NOTICE_ONLY')
    const result = projectParticipantMemory({ ...input([]), uses: [{ ...use, status: 'excluded' }], ballots: [{ actorId: 'juror-01', issueId: 'count', round: 'initial', choice: 'guilty', confidence: 60, rationale: 'NOW_EXCLUDED', valid: true, sourceRefs: [{ evidenceId: 'source', attribution: 'source' }] }] as never })
    expect(result.issueAssessments[0]).toMatchObject({ choice: 'requires_reassessment', usable: false, attribution: 'simulated_position' })
    expect(JSON.stringify(result)).not.toContain('NOW_EXCLUDED')
  })
})
