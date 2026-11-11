import request from 'supertest'
import { afterEach, describe, expect, it } from 'vitest'

import { createApp } from '../server/app'
import { CaseWorkflowService } from '../server/caseWorkflow'
import { createMatterArchive, importMatterArchive } from '../server/matterArchive'
import type { ModelClient } from '../server/minimax'
import { buildRecordCoverage } from '../server/recordCoverage'
import type { CaseModelV1 } from '../server/trialEngineTypes'
import { editableCaseModelSchema } from '../server/workflowSchemas'
import { addSource, cleanupAnalysisFixtures, memoryStore } from './analysisFixtures'

afterEach(cleanupAnalysisFixtures)

class UnusedModel implements ModelClient {
  async generateStage(): Promise<never> { throw new Error('No model call is expected.') }
}

const documentTypes = ['pleading', 'medical', 'expert_report', 'transcript', 'correspondence', 'financial', 'other'] as const

function world() {
  const store = memoryStore()
  const matter = store.createMatter({ title: 'Extension fixture', narrative: 'Claim 1: Fictional negligence\nClaim 2: Fictional occupiers liability\nClaim 3: Fictional damages' })
  const sources = documentTypes.map((type, index) => addSource(store, matter.id, `${type}.txt`, `Fictional ${type} record number ${index}.`))
  const workflow = new CaseWorkflowService(store)
  return { store, workflow, matterId: matter.id, sources }
}

type Issue = CaseModelV1['decisionIssues'][number]

// The extension fields, spread across the model so each one is exercised.
function extended(base: CaseModelV1, sources: Array<{ id: string }>) {
  const [first, second, third] = base.decisionIssues
  const decisionIssues: Issue[] = [
    { ...first, questionText: 'Was the first defendant negligent?', decider: 'jury', answerType: 'choice', order: 1 },
    { ...second, questionText: 'In what proportions was fault shared?', decider: 'jury', answerType: 'apportionment', dependsOn: [first.id], order: 2 },
    { ...third, questionText: 'What is the law on interest?', decider: 'judge', answerType: 'amount', dependsOn: [first.id, second.id], order: 3 },
  ]
  const witnesses: CaseModelV1['witnesses'] = (['fact', 'party', 'expert'] as const).map((kind, index) => ({
    id: `witness-${kind}`, name: `Fictional ${kind} witness`, kind, sourceRefs: [{ evidenceId: sources[index].id, attribution: 'manual' as const }],
    approvedStatementRefs: [{ evidenceId: sources[index].id, attribution: 'manual' as const }],
  }))
  const recordScope: NonNullable<CaseModelV1['recordScope']> = {
    description: 'Fictional record.',
    documents: documentTypes.map((documentType, index) => ({
      evidenceId: sources[index].id, kind: 'primary' as const, coverage: 'whole_document' as const, note: '', documentType,
    })),
    missingMaterials: [],
  }
  return { decisionIssues, witnesses, recordScope }
}

const issueExtensions = (issues: Issue[]) => issues.map(({ questionText, decider, answerType, dependsOn, order }) => ({ questionText, decider, answerType, dependsOn, order }))
const keysOf = (value: unknown) => JSON.stringify(value)

describe('models saved without the new fields', () => {
  it('load and re-save with no new keys and unchanged sections', () => {
    const { store, workflow, matterId } = world()
    const draft = workflow.draftCaseModel(matterId, 'ontario_civil_v1')
    expect(keysOf(draft)).not.toMatch(/questionText|"decider"|answerType|dependsOn|"order"|documentType|"kind":"(fact|party|expert)"/)
    const reloaded = store.workflow.getCaseModel(draft.id)
    expect(reloaded).toEqual(draft)
    const revised = workflow.reviseCaseModel(draft.id, {})
    expect(revised.version).toBe(draft.version + 1)
    for (const section of ['parties', 'decisionIssues', 'witnesses', 'disputedFacts', 'recordScope', 'evidenceMatrix', 'remedies'] as const) {
      expect(revised[section], section).toEqual(draft[section])
    }
    expect(keysOf(revised)).not.toMatch(/questionText|"decider"|answerType|dependsOn|documentType/)
    // Re-saving again changes nothing at all, down to the serialised bytes.
    const resaved = workflow.reviseCaseModel(revised.id, {})
    for (const section of ['parties', 'decisionIssues', 'witnesses', 'disputedFacts', 'recordScope', 'evidenceMatrix', 'remedies'] as const) {
      expect(keysOf(resaved[section]), section).toBe(keysOf(revised[section]))
    }
  })

  it('still approves, and an old model with no extensions keeps loading after a new one is saved', () => {
    const { store, workflow, matterId, sources } = world()
    const old = workflow.approveCaseModel(workflow.draftCaseModel(matterId, 'ontario_civil_v1').id)
    const fresh = workflow.draftCaseModel(matterId, 'ontario_civil_v1', extended(old, sources))
    expect(store.workflow.getCaseModel(old.id)).toEqual(old)
    expect(store.workflow.listCaseModels(matterId).map((model) => model.id)).toEqual([fresh.id, old.id])
  })
})

describe('each new field round-trips', () => {
  it('survives create, reload, revise, approval and a second revise', () => {
    const { store, workflow, matterId, sources } = world()
    const base = workflow.draftCaseModel(matterId, 'ontario_civil_v1')
    const input = extended(base, sources)
    const created = workflow.draftCaseModel(matterId, 'ontario_civil_v1', input)
    expect(issueExtensions(created.decisionIssues)).toEqual(issueExtensions(input.decisionIssues))
    expect(created.witnesses.map((witness) => witness.kind)).toEqual(['fact', 'party', 'expert'])
    expect(created.recordScope?.documents.map((doc) => doc.documentType)).toEqual([...documentTypes])
    // The existing `kind` is separate from the new `documentType`.
    expect(created.recordScope?.documents.every((doc) => doc.kind === 'primary')).toBe(true)

    const reloaded = store.workflow.getCaseModel(created.id)
    expect(reloaded).toEqual(created)

    const retitled = workflow.reviseCaseModel(created.id, { title: 'Retitled' })
    expect(retitled.title).toBe('Retitled')
    expect(issueExtensions(retitled.decisionIssues)).toEqual(issueExtensions(input.decisionIssues))
    expect(retitled.witnesses.map((witness) => witness.kind)).toEqual(['fact', 'party', 'expert'])
    expect(retitled.recordScope?.documents.map((doc) => doc.documentType)).toEqual([...documentTypes])

    // An edit changes only what was edited.
    const edited = workflow.reviseCaseModel(retitled.id, {
      decisionIssues: retitled.decisionIssues.map((issue, index) => (index === 0 ? { ...issue, decider: 'judge' as const, answerType: 'amount' as const } : issue)),
    })
    expect(issueExtensions(edited.decisionIssues)[0]).toMatchObject({ decider: 'judge', answerType: 'amount', questionText: 'Was the first defendant negligent?', order: 1 })
    expect(issueExtensions(edited.decisionIssues).slice(1)).toEqual(issueExtensions(input.decisionIssues).slice(1))

    const approved = workflow.approveCaseModel(edited.id)
    expect(store.workflow.getCaseModel(approved.id).decisionIssues[0].decider).toBe('judge')
    const again = workflow.reviseCaseModel(approved.id, {})
    expect(issueExtensions(again.decisionIssues)).toEqual(issueExtensions(approved.decisionIssues))
    expect(again.witnesses).toEqual(approved.witnesses)
    expect(again.recordScope).toEqual(approved.recordScope)
  })

  it('represents a judge-only issue', () => {
    const { workflow, matterId } = world()
    const base = workflow.draftCaseModel(matterId, 'ontario_civil_v1')
    const model = workflow.draftCaseModel(matterId, 'ontario_civil_v1', {
      decisionIssues: base.decisionIssues.map((issue, index) => (index === 1 ? { ...issue, decider: 'judge' as const, answerType: 'choice' as const, questionText: 'Is relief against the municipality available?' } : issue)),
    })
    expect(model.decisionIssues.map((issue) => issue.decider)).toEqual([undefined, 'judge', undefined])
    expect(workflow.approveCaseModel(model.id).decisionIssues[1]).toMatchObject({ decider: 'judge', answerType: 'choice' })
  })

  it('survives archive export and import, remapping evidence references but keeping every new field', async () => {
    const { store, workflow, matterId, sources } = world()
    const base = workflow.draftCaseModel(matterId, 'ontario_civil_v1')
    const model = workflow.approveCaseModel(workflow.draftCaseModel(matterId, 'ontario_civil_v1', extended(base, sources)).id)
    const archive = await createMatterArchive(store, matterId)
    const imported = await importMatterArchive(store, JSON.parse(JSON.stringify(archive)))
    const copy = store.workflow.listCaseModels(imported.id)[0]
    expect(issueExtensions(copy.decisionIssues)).toEqual(issueExtensions(model.decisionIssues))
    expect(copy.witnesses.map((witness) => witness.kind)).toEqual(['fact', 'party', 'expert'])
    expect(copy.recordScope?.documents.map((doc) => doc.documentType)).toEqual([...documentTypes])
    // The record scope still points at the imported matter's own evidence.
    const importedIds = new Set(store.listEvidence(imported.id).map((item) => item.id))
    expect(copy.recordScope?.documents.every((doc) => importedIds.has(doc.evidenceId))).toBe(true)
  })

  it('carries documentType into the run\'s record coverage view', () => {
    const { store, workflow, matterId, sources } = world()
    const base = workflow.draftCaseModel(matterId, 'ontario_civil_v1')
    const model = workflow.draftCaseModel(matterId, 'ontario_civil_v1', extended(base, sources))
    const coverage = buildRecordCoverage(model, store.listEvidence(matterId))
    expect(coverage.scope.documents.map((doc) => doc.documentType)).toEqual([...documentTypes])
    // Valid control: a model without the field produces no such key.
    const plain = buildRecordCoverage(base, store.listEvidence(matterId))
    expect(JSON.stringify(plain.scope.documents)).not.toContain('documentType')
  })
})

describe('validation', () => {
  const issue = {
    id: 'i1', kind: 'civil_claim', label: 'Claim', respondingPartyIds: ['d'], elements: [{ id: 'e1', label: 'Element', burden: 'Balance of probabilities', sourceRefs: [] }],
    permittedOutcomes: ['proved', 'not_proved'], sourceRefs: [],
  }
  const witness = { id: 'w1', name: 'Witness', sourceRefs: [], approvedStatementRefs: [] }
  const scope = (document: Record<string, unknown>) => ({ description: '', documents: [{ evidenceId: 'ev', kind: 'primary', coverage: 'whole_document', note: '', ...document }], missingMaterials: [] })
  const parse = (value: unknown) => editableCaseModelSchema.safeParse(value).success

  it('accepts every valid value (valid controls)', () => {
    for (const kind of ['fact', 'party', 'expert']) expect(parse({ witnesses: [{ ...witness, kind }] }), kind).toBe(true)
    for (const decider of ['jury', 'judge']) expect(parse({ decisionIssues: [{ ...issue, decider }] }), decider).toBe(true)
    for (const answerType of ['choice', 'amount', 'apportionment']) expect(parse({ decisionIssues: [{ ...issue, answerType }] }), answerType).toBe(true)
    for (const documentType of documentTypes) expect(parse({ recordScope: scope({ documentType }) }), documentType).toBe(true)
    expect(parse({ decisionIssues: [{ ...issue, order: 0, questionText: 'A question?', dependsOn: [] }] })).toBe(true)
    expect(parse({ decisionIssues: [{ ...issue, id: 'i1' }, { ...issue, id: 'i2', dependsOn: ['i1'] }] })).toBe(true)
  })

  it('rejects invalid values', () => {
    expect(parse({ witnesses: [{ ...witness, kind: 'juror' }] })).toBe(false)
    expect(parse({ witnesses: [{ ...witness, kind: 'Expert' }] })).toBe(false)
    expect(parse({ decisionIssues: [{ ...issue, decider: 'both' }] })).toBe(false)
    expect(parse({ decisionIssues: [{ ...issue, answerType: 'text' }] })).toBe(false)
    expect(parse({ decisionIssues: [{ ...issue, questionText: '' }] })).toBe(false)
    expect(parse({ decisionIssues: [{ ...issue, order: -1 }] })).toBe(false)
    expect(parse({ decisionIssues: [{ ...issue, order: 1.5 }] })).toBe(false)
    expect(parse({ decisionIssues: [{ ...issue, dependsOn: [''] }] })).toBe(false)
    expect(parse({ recordScope: scope({ documentType: 'photograph' }) })).toBe(false)
  })

  it('rejects a dependency on an unknown issue, on itself, or in a cycle', () => {
    const two = (a: Record<string, unknown>, b: Record<string, unknown>) => ({ decisionIssues: [{ ...issue, id: 'i1', ...a }, { ...issue, id: 'i2', ...b }] })
    expect(parse(two({ dependsOn: ['missing'] }, {}))).toBe(false)
    expect(parse(two({ dependsOn: ['i1'] }, {}))).toBe(false)
    expect(parse(two({ dependsOn: ['i2'] }, { dependsOn: ['i1'] }))).toBe(false)
    expect(parse(two({ dependsOn: ['i2', 'i2'] }, {}))).toBe(false)
    expect(parse(two({}, { dependsOn: ['i1'] }))).toBe(true)
  })

  it('answers 400 through the API for invalid values and 201 for the valid control', async () => {
    const { store, matterId } = world()
    const app = createApp({ store, trialForgeModelClient: new UnusedModel() })
    const draft = (model: Record<string, unknown>) => request(app).post(`/api/matters/${matterId}/case-models/draft`).send({ procedureAdapter: 'ontario_civil_v1', model })
    await draft({ decisionIssues: [{ ...issue, decider: 'judge', answerType: 'amount', order: 2, questionText: 'How much?' }] }).expect(201)
    await draft({ witnesses: [{ ...witness, kind: 'expert' }] }).expect(201)
    await draft({ recordScope: scope({ documentType: 'medical' }) }).expect(201)
    await draft({ decisionIssues: [{ ...issue, decider: 'jury-ish' }] }).expect(400)
    await draft({ witnesses: [{ ...witness, kind: 'bystander' }] }).expect(400)
    await draft({ recordScope: scope({ documentType: 'x-ray' }) }).expect(400)
    await draft({ decisionIssues: [{ ...issue, dependsOn: ['nope'] }] }).expect(400)
  })

  it('answers 400 through the revise route too', async () => {
    const { store, workflow, matterId } = world()
    const model = workflow.draftCaseModel(matterId, 'ontario_civil_v1')
    const app = createApp({ store, trialForgeModelClient: new UnusedModel() })
    await request(app).post(`/api/case-models/${model.id}/versions`).send({ witnesses: [{ ...witness, kind: 'expert' }] }).expect(201)
    await request(app).post(`/api/case-models/${model.id}/versions`).send({ witnesses: [{ ...witness, kind: 'robot' }] }).expect(400)
  })
})

