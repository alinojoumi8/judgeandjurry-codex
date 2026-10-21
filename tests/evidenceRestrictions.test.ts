import { describe, expect, it } from 'vitest'
import { projectRestrictedEvidence, permittedReference, validateEvidenceScope } from '../server/evidenceRestrictions'
import { assembleActorContext } from '../server/actorContext'
import type { EvidenceItem } from '../server/types'
import type { EvidenceUse } from '../server/trialEngineTypes'
import { createCourtroomFixture, ScriptedCourtroomModel } from '../samples/courtroom-realism/fixture'
import { createMatterArchive, importMatterArchive } from '../server/matterArchive'
import { CaseStore } from '../server/db'
import { traceReference } from '../server/decisionTrace'

const source = { id: 'e', exhibitId: 'E-1', name: 'Mixed account', text: 'Allowed notice.\n\nSECRET allegation.', summary: 'SECRET allegation.', tags: ['SECRET'] } as EvidenceItem
const use = { evidenceId: 'e', status: 'limited', purposes: ['notice'], redactions: [], hiddenFrom: [], note: '', scope: { paragraphs: [1], issueIds: ['count1'], partyIds: ['p1'], prohibitedPurposes: ['truth'] } } as unknown as EvidenceUse
const scope = { issueId: 'count1', partyIds: ['p1'], purpose: 'notice' }
describe('enforced source scope', () => {
  it('handles incomplete scope and redacted metadata without accepting foreign or invented references', () => {
    const partyOnly = { ...use, scope: { partyIds: ['p1'] } }
    expect(projectRestrictedEvidence(source, partyOnly, {})).toBeNull()
    expect(projectRestrictedEvidence(source, partyOnly, { partyIds: ['p1'] })).not.toBeNull()
    const purposeOnly = { ...use, scope: { prohibitedPurposes: ['truth'] } }
    expect(projectRestrictedEvidence(source, purposeOnly, {})).toBeNull()
    expect(projectRestrictedEvidence(source, { ...use, scope: { paragraphs: [99] } }, {})).toBeNull()
    expect(projectRestrictedEvidence(source, { ...use, status: 'reserved', scope: undefined }, {})).toBeNull()
    const redacted = projectRestrictedEvidence(source, { ...use, scope: undefined, status: 'redacted', redactions: ['SECRET'] }, {})!
    expect(JSON.stringify(redacted)).not.toContain('SECRET')
    expect(permittedReference({ evidenceId: 'foreign', attribution: 'source' }, source, undefined, {})).toBe(false)
    expect(permittedReference({ evidenceId: 'e', locator: { paragraph: 1 }, attribution: 'source' }, source, undefined, {})).toBe(true)
    expect(permittedReference({ evidenceId: 'e', quote: 'invented', locator: { paragraph: 1 }, attribution: 'source' }, source, undefined, {})).toBe(false)
    expect(() => validateEvidenceScope(use, source, ['count1'], ['p2'])).toThrow(/party/)
    const reference = { evidenceId: 'e', quote: 'Allowed notice.', locator: { paragraph: 1 }, attribution: 'source' as const }
    expect(permittedReference(reference, source, use, scope)).toBe(false)
    expect(permittedReference({ ...reference, purpose: 'notice' }, source, use, { issueId: 'count1', partyIds: ['p1'] })).toBe(true)
    expect(permittedReference(reference, source, { ...use, status: 'excluded' }, {})).toBe(false)
  })
  it('preserves ruling scope through archive import and filters actual ballot requests', async () => {
    const client = new ScriptedCourtroomModel()
    const f = createCourtroomFixture(client)
    const restored = new CaseStore(':memory:')
    try {
      const scoped = { paragraphs: [1], issueIds: [f.model.decisionIssues[0].id], partyIds: f.model.decisionIssues[0].respondingPartyIds }
      const parent = f.store.workflow.getAdmissionLedger(f.run.admissionLedgerId!)
      const ledger = f.store.workflow.createAdmissionLedger({ matterId: f.matter.id, reason: 'Scoped fixture', evidenceUses: parent.evidenceUses.map(u => u.evidenceId === f.evidence.id ? { ...u, scope: scoped } : u) })
      f.store.workflow.updateTrialRun(f.run.id, { admissionLedgerId: ledger.id })
      expect(f.engine.actorContext(f.run.id, 'crown').evidence).toEqual([])
      expect(f.engine.actorContext(f.run.id, 'crown', undefined, { issueId: 'wrong', partyIds: scoped.partyIds }).evidence).toEqual([])
      await f.engine.runAutonomous(f.run.id)
      f.engine.command(f.run.id, { type: 'approve_checkpoint' })
      await f.engine.runAutonomous(f.run.id)
      const requests = client.requests.filter(r => r.stage === 'juror_ballot')
      expect(requests).toHaveLength(24)
      expect(requests.every(r => r.evidence.every(e => e.id !== f.evidence.id || e.authorizedPassages?.[0].paragraph === 1))).toBe(true)
      const archive = await createMatterArchive(f.store, f.matter.id)
      const imported = await importMatterArchive(restored, archive)
      expect(restored.workflow.listAdmissionLedgers(imported.id)[0]?.evidenceUses.some(u => JSON.stringify(u.scope) === JSON.stringify(scoped))).toBe(true)
    } finally { restored.close(); f.store.close() }
  })
  it('rejects non-existent passages, foreign issues and contradictory purposes', () => {
    expect(() => validateEvidenceScope(use, source, ['count1'], ['p1'])).not.toThrow()
    expect(() => validateEvidenceScope({ ...use, scope: { paragraphs: [3] } }, source, [], [])).toThrow(/passage/)
    expect(() => validateEvidenceScope(use, source, ['count2'], ['p1'])).toThrow(/issue or party/)
    expect(() => validateEvidenceScope({ ...use, purposes: ['truth'] }, source, ['count1'], ['p1'])).toThrow(/permitted and prohibited/)
  })
  it('withholds scoped documents when issue, party or purpose is unknown or mismatched', () => {
    for (const attempt of [{}, { ...scope, issueId: 'count2' }, { ...scope, partyIds: ['p2'] }, { ...scope, purpose: 'truth' }, { ...scope, purpose: 'guilt' }]) expect(projectRestrictedEvidence(source, use, attempt)).toBeNull()
  })
  it('projects only permitted paragraphs and drops derivative summaries and tags', () => {
    const projected = projectRestrictedEvidence(source, use, scope)!
    expect(projected.text).toBe('Allowed notice.')
    expect(JSON.stringify(projected)).not.toContain('SECRET')
    expect(projected.authorizedPassages?.map(p => p.paragraph)).toEqual([1])
  })
  it('checks exact references, original paragraph numbers and declared purpose', () => {
    const ref = { evidenceId: 'e', attribution: 'source' as const, quote: 'Allowed notice.', locator: { paragraph: 1 }, purpose: 'notice' }
    expect(permittedReference(ref, source, use, scope)).toBe(true)
    for (const invalid of [{ ...ref, locator: { paragraph: 2 } }, { ...ref, quote: 'SECRET allegation.' }, { ...ref, purpose: 'truth' }, { ...ref, quote: undefined, locator: undefined }]) expect(permittedReference(invalid, source, use, scope)).toBe(false)
    const second = projectRestrictedEvidence(source, { ...use, scope: { paragraphs: [2] }, purposes: [] }, {})!
    expect(second.authorizedPassages?.[0].paragraph).toBe(2)
    const ledger = { evidenceUses: [use] } as never
    expect(traceReference(ref, [source], ledger, scope).status).toBe('located')
    expect(traceReference({ ...ref, quote: 'SECRET allegation.' }, [source], ledger, scope)).toMatchObject({ status: 'restricted', quote: undefined })
  })
  it('invalidates earlier events and assessments whose references exceed the current scope', () => {
    const result = assembleActorContext({ runId: 'r', actorId: 'j', roles: ['juror'], throughSequence: 2, protocol: true, approvedStatementRefs: [], useScope: scope, evidence: [source], uses: [use],
      events: [{ id: 'old', trialRunId: 'r', sequence: 1, phase: 'evidence', type: 'witness_answer', payload: { text: 'SECRET allegation.' }, visibleTo: ['public'], sourceRefs: [{ evidenceId: 'e', quote: 'SECRET allegation.', locator: { paragraph: 2 }, purpose: 'notice', attribution: 'source' }], createdAt: 'now' }],
      ballots: [{ actorId: 'j', issueId: 'count1', valid: true, sourceRefs: [{ evidenceId: 'e', quote: 'SECRET allegation.', purpose: 'notice', attribution: 'source' }], rationale: 'SECRET', choice: 'guilty', round: 'initial', confidence: 80 }] as never,
    })
    expect(JSON.stringify(result)).not.toContain('SECRET')
    expect(result.memory.invalidatedEventIds).toContain('old')
    expect(result.memory.issueAssessments[0].usable).toBe(false)
  })
  it('does not reintroduce the rest of a shared paragraph through witness passage metadata', () => {
    const mixed = { ...source, text: 'Own account. OTHER_WITNESS_SECRET' }
    const result = assembleActorContext({ runId: 'r', actorId: 'w', roles: ['witness'], throughSequence: 1, protocol: true, events: [], useScope: scope, evidence: [mixed], uses: [use], approvedStatementRefs: [{ evidenceId: 'e', quote: 'Own account.', attribution: 'source' }] })
    expect(result.evidence[0].text).toBe('Own account.')
    expect(JSON.stringify(result)).not.toContain('OTHER_WITNESS_SECRET')
  })
})
