import { describe, expect, it } from 'vitest'
import { openingAuditSetup } from '../server/grounding'

describe('opening audit setup boundaries', () => {
  it('does not manufacture party positions, procedural rules or future evidence plans from issue labels and private advocacy', () => {
    const setup = openingAuditSetup('Approved issue(s): issue-1: Fictional disputed transfer\nPrivate theory: the Defence accepts the notice and the Crown will call witnesses.\nActor: crown')
    expect(setup).toEqual({ issueLabels: ['issue-1: Fictional disputed transfer'], partyPositions: [], legalPackets: [], procedureInstructions: [], evidencePlans: [] })
  })

  it('passes supplied positions and fictional procedure/plan instructions without private or prior generated text', () => {
    const setup = openingAuditSetup('Approved party position: Defence disputes notice delivery.\nApproved scenario procedure: In this fictional exercise, openings precede witness questions.\nApproved evidence plan: Mira will describe the handover, not envelope contents.\nPinned legal packet abc123: {"elements":["fictional notice condition"]}\nPrivate theory: PRIVATE_901\nGenerated assertion: the accused confessed.')
    expect(setup.partyPositions).toEqual(['Defence disputes notice delivery.'])
    expect(setup.procedureInstructions).toEqual(['In this fictional exercise, openings precede witness questions.'])
    expect(setup.evidencePlans).toEqual(['Mira will describe the handover, not envelope contents.'])
    expect(setup.legalPackets).toEqual(['{"elements":["fictional notice condition"]}'])
    expect(JSON.stringify(setup)).not.toMatch(/PRIVATE_901|confessed/)
  })

  it('ignores misleading labels embedded inside another field and preserves an absent legal packet as absent', () => {
    const setup = openingAuditSetup('Private theory: Approved party position: Defence concedes guilt.\nResponse repair: Approved scenario procedure: Counsel must use three headings.')
    expect(Object.values(setup).every(items => items.length === 0)).toBe(true)
  })
})
