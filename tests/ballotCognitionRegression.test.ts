import { readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { CaseStore } from '../server/db'
import { TrialEngineService } from '../server/trialEngine'
import type { TrialRunConfig } from '../server/trialEngineTypes'
import { civilConfig, civilIssue, civilWorld } from './civilFixtures'
import { GoldenModel, goldenCivilJury, goldenCriminalFull } from './engineGolden'

// The golden file records every request the engine sent to a scripted model, and
// every event, ballot and decision it saved, for two runs. It was captured from
// the engine as it stood BEFORE ballot contract v2 and juror cognition existed
// (the capture was repeated against a copy of the engine with those changes
// reverted and the two files were byte-identical). A run that does not opt in
// must reproduce it exactly. Do not regenerate it to make this test pass: a
// difference here is a change to what jurors are told or how a decision is made.
// Set UPDATE_ENGINE_GOLDEN=1 only for a deliberate, reviewed change.
const goldenPath = 'tests/fixtures/engine-golden.json'
const golden = () => JSON.parse(readFileSync(goldenPath, 'utf8')) as { civilJury: unknown; criminalFull: unknown }

describe('runs that do not opt in behave exactly as before', () => {
  it.skipIf(!process.env.UPDATE_ENGINE_GOLDEN)('regenerates the golden when asked to', async () => {
    writeFileSync(goldenPath, JSON.stringify({ civilJury: await goldenCivilJury(), criminalFull: await goldenCriminalFull() }, null, 1))
  })

  it('sends the same prompts and reaches the same decisions in a civil jury run', async () => {
    expect(await goldenCivilJury()).toEqual(golden().civilJury)
  })

  it('sends the same prompts and reaches the same decisions in a full criminal run with a witness', async () => {
    expect(await goldenCriminalFull()).toEqual(golden().criminalFull)
  })

  it('treats explicit off values the same as leaving the settings out', async () => {
    // The deliberation forecast (F9) was added after the golden was captured, and is held to the same file.
    // Damages amounts (F12) and the damages condition (F13) are held to the same file.
    const off = { ballotContract: undefined, jurorCognition: false, deliberationForecast: false, strawPollCounts: undefined, damagesAmounts: false, damagesCondition: undefined } as unknown as Partial<TrialRunConfig>
    expect(await goldenCivilJury(off)).toEqual(golden().civilJury)
    expect(await goldenCriminalFull(off)).toEqual(golden().criminalFull)
  })

  it('treats the advocacy style setting (F15) off, and an empty list, the same as leaving it out', async () => {
    // Advocacy styles are held to the same file: no prompt, event or decision differs when no style is chosen.
    for (const advocacy of [undefined, []]) {
      const off = { advocacy } as unknown as Partial<TrialRunConfig>
      expect(await goldenCivilJury(off)).toEqual(golden().civilJury)
      expect(await goldenCriminalFull(off)).toEqual(golden().criminalFull)
    }
  })

  it('leaves no trace of either setting in a run it did not ask for', async () => {
    const store = new CaseStore(':memory:')
    const world = civilWorld([civilIssue('claim')], [store])
    const model = new GoldenModel()
    const engine = new TrialEngineService(world.store, model)
    const run = engine.createRun({ matterId: world.matterId, caseModelId: world.model.id, config: { ...civilConfig('jury', 'trace'), jurorCognition: false, deliberationForecast: false, damagesAmounts: false, advocacy: [] } as unknown as TrialRunConfig }).run
    await engine.runAutonomous(run.id)
    expect(JSON.stringify(world.store.workflow.getTrialRun(run.id).config)).not.toMatch(/ballotContract|jurorCognition|deliberationForecast|strawPollCounts|damagesAmounts|damagesCategories|damagesCurrency|damagesCondition|damagesExcluded|advocacy/)
    expect(model.requests.some((request) => request.stage === 'juror_appraisal')).toBe(false)
    expect(model.requests.some((request) => request.ballotContractVersion !== undefined)).toBe(false)
    expect(model.requests.some((request) => request.deliberationContract !== undefined || /straw-poll/.test(request.packet))).toBe(false)
    const events = world.store.workflow.listTrialEvents(run.id)
    expect(events.some((event) => /appraisal|jury_roles|straw_poll|round_planned|advocacy/.test(event.type))).toBe(false)
    expect(model.requests.some((request) => /Delivery style/.test(request.packet))).toBe(false)
    // A deliberation turn carries none of the forecast's fields.
    const turns = events.filter((event) => event.type === 'juror_deliberation_turn')
    expect(turns.length).toBeGreaterThan(0)
    for (const turn of turns) for (const key of ['stance', 'replyToEventId', 'replyToActorId', 'slot', 'structureProblems']) expect(turn.payload).not.toHaveProperty(key)
    // A ballot cast without contract v2 has none of its fields.
    for (const ballot of world.store.workflow.listBallots(run.id)) expect(Object.keys(ballot)).not.toEqual(expect.arrayContaining(['elementFindings']))
    for (const ballot of world.store.workflow.listBallots(run.id)) {
      expect('elementFindings' in ballot || 'amounts' in ballot || 'apportionment' in ballot).toBe(false)
    }
    world.store.close()
    store.close()
  })
})
