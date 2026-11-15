import { afterEach, describe, expect, it } from 'vitest'

import { CaseWorkflowService } from '../server/caseWorkflow'
import { CaseStore } from '../server/db'

// Plan section 12, item 9: the motion docket could be filed only by an accused,
// respondent or defendant. Any selected party may move now; leaving the party
// out keeps the earlier behaviour exactly. Fictional data only.
const stores: CaseStore[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close() })

const refs = [{ attribution: 'manual' as const }]

function world(adapter: 'ontario_civil_v1' | 'ontario_criminal_jury_v1' = 'ontario_civil_v1') {
  const store = new CaseStore(':memory:')
  stores.push(store)
  const matter = store.createMatter({ title: 'Fictional docket matter', narrative: 'Claim 1: A fictional claim.' })
  const text = 'The fictional production is incomplete production of the fictional file. This source is unsigned.'
  const item = store.addEvidence(matter.id, { name: 'production.txt', type: 'text', mimeType: 'text/plain', size: text.length, text, summary: text, tags: [], ingestionStatus: 'stored' })
  const workflow = new CaseWorkflowService(store)
  const parties = adapter === 'ontario_civil_v1'
    ? [{ id: 'plaintiff', name: 'Fictional Plaintiff', role: 'plaintiff' as const, sourceRefs: refs }, { id: 'defendant-1', name: 'Fictional Defendant', role: 'defendant' as const, sourceRefs: refs }]
    : [{ id: 'crown', name: 'Crown', role: 'crown' as const, sourceRefs: refs }, { id: 'accused-1', name: 'Fictional Accused', role: 'accused' as const, sourceRefs: refs }]
  const model = workflow.approveCaseModel(workflow.draftCaseModel(matter.id, adapter, { parties, witnesses: [] }).id)
  workflow.analyzeDisclosure(matter.id, model.id)
  return { store, workflow, model, matterId: matter.id, evidenceId: item.id }
}

describe('motion docket: any selected party', () => {
  it('keeps the earlier behaviour when no party is chosen: the defendant moves, the plaintiff does not', () => {
    const { workflow, model } = world()
    const docket = workflow.draftMotionDocket(model.id)
    expect(docket.length).toBeGreaterThan(0)
    expect(new Set(docket.map((motion) => motion.movingPartyId))).toEqual(new Set(['defendant-1']))
  })

  it('keeps the earlier behaviour for an accused, and returns nothing when only the Crown is on the model', () => {
    const { workflow, model } = world('ontario_criminal_jury_v1')
    expect(new Set(workflow.draftMotionDocket(model.id).map((motion) => motion.movingPartyId))).toEqual(new Set(['accused-1']))
    const store = new CaseStore(':memory:')
    stores.push(store)
    const matter = store.createMatter({ title: 'Crown only', narrative: 'Count 1: x.' })
    const alone = new CaseWorkflowService(store)
    // A draft is enough: the docket reads the model's parties, not its approval.
    const crownOnly = alone.draftCaseModel(matter.id, 'ontario_criminal_jury_v1', { parties: [{ id: 'crown', name: 'Crown', role: 'crown', sourceRefs: refs }], witnesses: [] })
    expect(alone.draftMotionDocket(crownOnly.id)).toEqual([])
  })

  it('lets the plaintiff move when the plaintiff is chosen, with the same grounds and permitted relief', () => {
    const { workflow, model } = world()
    const plaintiff = workflow.draftMotionDocket(model.id, 'plaintiff')
    expect(plaintiff.length).toBeGreaterThan(0)
    expect(new Set(plaintiff.map((motion) => motion.movingPartyId))).toEqual(new Set(['plaintiff']))
    expect(plaintiff.every((motion) => motion.status === 'draft')).toBe(true)
    // The same findings produce the same kinds of motion as the default party's docket.
    const other = world()
    const defendant = other.workflow.draftMotionDocket(other.model.id)
    expect(plaintiff.map((motion) => motion.motionType).sort()).toEqual(defendant.map((motion) => motion.motionType).sort())
    expect(plaintiff.map((motion) => motion.requestedRelief)).toEqual(defendant.map((motion) => motion.requestedRelief))
  })

  it('lets a chosen party who could already move (the defendant) move exactly as before', () => {
    const left = world()
    const right = world()
    const implicit = left.workflow.draftMotionDocket(left.model.id).map(({ title, motionType, requestedRelief, movingPartyId }) => ({ title, motionType, requestedRelief, movingPartyId }))
    const explicit = right.workflow.draftMotionDocket(right.model.id, 'defendant-1').map(({ title, motionType, requestedRelief, movingPartyId }) => ({ title, motionType, requestedRelief, movingPartyId }))
    expect(explicit).toEqual(implicit)
  })

  it('lets the Crown move when it is chosen', () => {
    const { workflow, model } = world('ontario_criminal_jury_v1')
    expect(new Set(workflow.draftMotionDocket(model.id, 'crown').map((motion) => motion.movingPartyId))).toEqual(new Set(['crown']))
  })

  it('refuses a party that is not on the case model and drafts nothing', () => {
    const { workflow, model, matterId } = world()
    expect(() => workflow.draftMotionDocket(model.id, 'nobody')).toThrow(/not present in the case model/)
    expect(workflow.listMotions(matterId)).toEqual([])
  })

  it('does not draft a second motion for a source the same party already has one for, and still lets another party move', () => {
    const { workflow, model, matterId } = world()
    const first = workflow.draftMotionDocket(model.id, 'plaintiff')
    expect(workflow.draftMotionDocket(model.id, 'plaintiff')).toHaveLength(first.length)
    const both = workflow.draftMotionDocket(model.id, 'defendant-1')
    expect(both.length).toBe(first.length * 2)
    expect(new Set(workflow.listMotions(matterId).map((motion) => motion.movingPartyId))).toEqual(new Set(['plaintiff', 'defendant-1']))
  })
})
