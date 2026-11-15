import { afterEach, describe, expect, it } from 'vitest'

import { TrialEngineService } from '../server/trialEngine'
import type { CaseStore } from '../server/db'
import { civilConfig, civilIssue, civilWorld, ScriptedCivilModel, type Leaning } from './civilFixtures'

const stores: CaseStore[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close() })

// Plan section 12, item 1. A juror's `leaning` is expressed by side: 'crown'
// is the claimant (plaintiff or prosecution) side and 'defence' is the defence
// side. The ballot must record the answer that matches the side the juror
// favours, even when the defence is the party that must prove the question.
const issues = [
  civilIssue('claim'),
  civilIssue('contributory', { kind: 'civil_defence', label: 'Was the plaintiff contributorily negligent?', claimantPartyId: 'defendant-1', respondingPartyIds: ['plaintiff'] }),
  civilIssue('special', { kind: 'special_question', label: 'Did the plaintiff fail to wear a seat belt?', claimantPartyId: 'defendant-1', respondingPartyIds: ['plaintiff'], permittedOutcomes: ['yes', 'no', 'no_decision'] }),
]

async function finalChoices(leaning: Leaning) {
  const world = civilWorld(issues, stores)
  const model = new ScriptedCivilModel(leaning)
  const engine = new TrialEngineService(world.store, model)
  const run = engine.createRun({ matterId: world.matterId, caseModelId: world.model.id, config: civilConfig('jury') }).run
  await engine.runAutonomous(run.id)
  const ballots = world.store.workflow.listBallots(run.id, 'final')
  const choices: Record<string, string[]> = {}
  for (const ballot of ballots) (choices[ballot.issueId] ??= []).push(ballot.choice)
  return { choices, model, ballots, sheet: world.store.workflow.getDecisionSheet(run.id)! }
}

describe('leaning-to-choice mapping on defence-favouring questions', () => {
  it('records the side-matching answer when jurors favour the claimant side (control, and the reversed answers)', async () => {
    const { choices, ballots } = await finalChoices('crown')
    expect(ballots).toHaveLength(18)
    expect(new Set(choices.claim)).toEqual(new Set(['proved']))
    // The defence must prove contributory negligence; jurors who favour the
    // plaintiff must answer that it was NOT proved / "no".
    expect(new Set(choices.contributory)).toEqual(new Set(['not_proved']))
    expect(new Set(choices.special)).toEqual(new Set(['no']))
  })

  it('records the side-matching answer when jurors favour the defence side', async () => {
    const { choices, sheet } = await finalChoices('defence')
    expect(new Set(choices.claim)).toEqual(new Set(['not_proved']))
    expect(new Set(choices.contributory)).toEqual(new Set(['proved']))
    expect(new Set(choices.special)).toEqual(new Set(['yes']))
    const byIssue = Object.fromEntries(sheet.decisions.map((decision) => [decision.issueId, decision.outcome]))
    expect(byIssue).toEqual({ claim: 'not_proved', contributory: 'proved', special: 'yes' })
  })

  it('records an undecided juror as no decision on every kind', async () => {
    const { choices } = await finalChoices('mixed')
    for (const issueId of ['claim', 'contributory', 'special']) expect(new Set(choices[issueId])).toEqual(new Set([issueId === 'special' ? 'no_decision' : 'no_decision']))
  })

  it('tells jurors what leaning means only on a question the defence must prove', async () => {
    const { model } = await finalChoices('crown')
    const ballotPrompts = model.requests.filter((request) => request.stage === 'juror_ballot').map((request) => request.packet)
    const claim = ballotPrompts.filter((packet) => packet.includes('Decide only claim:'))
    const contributory = ballotPrompts.filter((packet) => packet.includes('Decide only contributory:'))
    expect(claim.length).toBeGreaterThan(0)
    expect(claim.every((packet) => !packet.includes('Side vocabulary'))).toBe(true)
    expect(contributory.every((packet) => packet.includes('Side vocabulary'))).toBe(true)
  })
})
