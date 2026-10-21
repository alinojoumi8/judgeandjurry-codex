import { expect, it } from 'vitest'
import { createCourtroomFixture, ScriptedCourtroomModel } from '../samples/courtroom-realism/fixture'

it.each(['missing', 'wrong_instruction', 'unattributed_change'] as const)('withholds a decision when isolated ballots fail %s validation', async problem => {
  const scripted = new ScriptedCourtroomModel()
  const client = { generateStage: async (request: Parameters<typeof scripted.generateStage>[0]) => {
    const result = await scripted.generateStage(request)
    if (request.stage !== 'juror_ballot') return result
    if (problem === 'missing') return { ...result, jurors: [] }
    if (problem === 'wrong_instruction') return { ...result, jurors: result.jurors.map(j => ({ ...j, instructionEventId: 'foreign-instruction' })) }
    return request.ballotRound === 'final' ? { ...result, jurors: result.jurors.map(j => ({ ...j, leaning: 'crown' as const, mindChangedBecause: '', changedByEventId: 'foreign-event' })) } : result
  } }
  const f = createCourtroomFixture(client)
  try {
    await f.engine.runAutonomous(f.run.id)
    f.engine.command(f.run.id, { type: 'approve_checkpoint' })
    const view = await f.engine.runAutonomous(f.run.id)
    expect(view.ballots.filter(b => b.round === 'final').every(b => !b.valid)).toBe(true)
    expect(view.decisionSheet?.complete).toBe(false)
    expect(view.decisionSheet?.decisions.every(d => d.outcome !== 'guilty')).toBe(true)
  } finally { f.store.close() }
})

it('rejects identity impersonation, wrong actors and cross-matter run configuration without changing the current run', () => {
  const f = createCourtroomFixture(new ScriptedCourtroomModel())
  try {
    const input = { matterId: f.matter.id, caseModelId: f.model.id, config: f.run.config }
    expect(() => f.engine.createRun({ ...input, matterId: f.store.createMatter({ title: 'Different fictional matter' }).id })).toThrow(/belong/)
    expect(() => f.engine.createRun({ ...input, config: { ...input.config, mode: 'screen' } })).toThrow(/full/)
    const impersonated = f.store.workflow.createCaseModel({ ...f.model, witnesses: [{ ...f.model.witnesses[0], id: 'juror-01' }] })
    expect(() => f.engine.createRun({ ...input, caseModelId: impersonated.id })).toThrow(/identit|impersonat/)
    expect(() => f.engine.actorContext(f.run.id, 'crown', ['judge'])).toThrow(/does not hold/)
    expect(() => f.engine.actorContext(f.run.id, 'unknown')).toThrow()
    expect(() => f.engine.actorInputAudit(f.run.id, 'unknown-input')).toThrow()
    expect(() => f.engine.courtroomCommand(f.run.id, { commandId: 'unknown', actorId: 'unknown', expectedSequence: 0, action: { type: 'jury_return' } })).toThrow()
    expect(f.store.workflow.getTrialRun(f.run.id).status).toBe('ready')
  } finally { f.store.close() }
})
