import { afterEach, describe, expect, it } from 'vitest'

import type { CaseStore } from '../server/db'
import { FrameworkService } from '../server/frameworks/service'
import { ontarioCivilPack } from '../server/frameworks/packs/ontario-civil'
import type { ModelClient, StageRequest } from '../server/minimax'
import { advocacyStyles, styleById } from '../server/styles/catalogue'
import { TrialEngineService } from '../server/trialEngine'
import { cognitionConfig, cognitionWorld } from './cognitionFixtures'
import { PlantedModel } from './forecastFixtures'

const stores: CaseStore[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close() })

// A model that records what it is asked and does not echo a style into its answers, so any appearance of a style in a request comes from the engine.
class Recorder implements ModelClient {
  readonly requests: StageRequest[] = []
  private readonly inner = new PlantedModel()
  async generateStage(request: StageRequest) {
    this.requests.push(request)
    return this.inner.generateStage(request)
  }
}

const isPartyAdvocacy = (request: StageRequest, party: string) => /_opening$|_rebuttal$/.test(request.stage) && request.courtroomActor?.id === party

async function styledRun(options: { advocacy: Array<{ partyId: string; id: (typeof advocacyStyles)[number]['id'] }>; mode?: 'screen' | 'full'; seed?: string }) {
  const world = cognitionWorld(stores)
  new FrameworkService(world.store).setForMatter(world.matterId, { packId: ontarioCivilPack.id, changedBy: 'Fictional Paralegal', overrides: [] })
  const model = new Recorder()
  const engine = new TrialEngineService(world.store, model)
  const config = { ...cognitionConfig({ jurorCognition: undefined, mode: options.mode ?? 'full', seed: options.seed ?? 'isolation' }), advocacy: options.advocacy }
  const run = engine.createRun({ matterId: world.matterId, caseModelId: world.model.id, config }).run
  const finished = await engine.runAutonomous(run.id)
  return { world, model, run: finished.run, events: world.store.workflow.listTrialEvents(run.id) }
}

describe('the chosen style reaches only the styled party\'s own advocacy requests', () => {
  it('puts the style text in the plaintiff\'s opening and closing requests, and in no other request of the run (canary)', async () => {
    const style = styleById('theatrical_storytelling')
    const { model, run, events } = await styledRun({ advocacy: [{ partyId: 'plaintiff', id: style.id }] })
    expect(run.status).toBe('completed')
    const carriers = model.requests.filter((request) => request.packet.includes(style.text))
    // The plaintiff opens and closes; both requests carry the style, and nothing else does.
    expect(carriers.map((request) => request.stage).sort()).toEqual(['crown_opening', 'crown_rebuttal'])
    expect(carriers.every((request) => isPartyAdvocacy(request, 'plaintiff'))).toBe(true)
    expect(carriers[0]!.packet).toContain('Delivery style for your opening argument')
    // Nothing about the style, in any form, reaches the other party, a juror, the judge or any other call.
    const rest = model.requests.filter((request) => !carriers.includes(request))
    expect(rest.length).toBeGreaterThan(20)
    expect(rest.some((request) => request.stage === 'defence_opening')).toBe(true)
    expect(rest.some((request) => request.stage === 'juror_ballot')).toBe(true)
    for (const request of rest) {
      const whole = JSON.stringify(request)
      for (const needle of [style.text, style.id, style.label, 'Argue through story', 'Delivery style', 'advocacy_style']) expect(whole, `${request.stage} for ${request.courtroomActor?.id}`).not.toContain(needle)
    }
    // The run records the pinned style for the owner, in the run's settings and in a non-public event.
    expect(run.config.advocacy).toEqual([{ partyId: 'plaintiff', id: style.id, catalogueVersion: 'advocacy-styles-1', text: style.text }])
    const applied = events.filter((event) => event.type === 'advocacy_style_applied')
    expect(applied.map((event) => event.payload.move)).toEqual(['openings', 'closings'])
    for (const event of applied) {
      expect(event.visibleTo).toEqual(['user', 'role:system'])
      expect(event.payload).toMatchObject({ partyId: 'plaintiff', styleId: style.id })
    }
    // No public event carries the style or its name.
    expect(JSON.stringify(events.filter((event) => event.visibleTo.includes('public')))).not.toMatch(/theatrical|advocacy_style|Delivery style/)
    // The styled party's argument stays a public submission with the same shape.
    expect(events.filter((event) => event.type === 'public_submission' && event.actorId === 'plaintiff').length).toBe(2)
  })

  it('styles the defence only when the defence is the styled party, and then the plaintiff\'s requests never see it', async () => {
    const style = styleById('concise')
    const { model } = await styledRun({ advocacy: [{ partyId: 'defendant-1', id: style.id }], mode: 'screen' })
    const carriers = model.requests.filter((request) => request.packet.includes(style.text))
    expect(carriers.map((request) => [request.stage, request.courtroomActor?.id])).toEqual([['defence_opening', 'defendant-1']])
    for (const request of model.requests.filter((candidate) => !carriers.includes(candidate))) expect(JSON.stringify(request)).not.toContain(style.text)
  })

  it('two parties can each have their own style, and each style reaches only its own party', async () => {
    const plaintiffStyle = styleById('moral_appeal')
    const defenceStyle = styleById('expert_driven_logic')
    const { model } = await styledRun({ advocacy: [{ partyId: 'plaintiff', id: plaintiffStyle.id }, { partyId: 'defendant-1', id: defenceStyle.id }], mode: 'screen' })
    for (const request of model.requests) {
      expect(request.packet.includes(plaintiffStyle.text)).toBe(isPartyAdvocacy(request, 'plaintiff'))
      expect(request.packet.includes(defenceStyle.text)).toBe(isPartyAdvocacy(request, 'defendant-1'))
    }
  })

  it('does not weaken the source check: a styled argument is generated with grounding still required and the same evidence and restrictions', async () => {
    const style = styleById('theatrical_storytelling')
    const plain = await styledRun({ advocacy: [], mode: 'screen', seed: 'grounding' })
    const styled = await styledRun({ advocacy: [{ partyId: 'plaintiff', id: style.id }], mode: 'screen', seed: 'grounding' })
    const opening = (model: Recorder) => model.requests.find((request) => request.stage === 'crown_opening')!
    expect(opening(styled.model).groundingRequired).toBe(true)
    expect(opening(styled.model).groundingContext).toBe(opening(plain.model).groundingContext)
    expect(opening(styled.model).evidence.map((item) => item.exhibitId)).toEqual(opening(plain.model).evidence.map((item) => item.exhibitId))
    // The style is added after everything else in the packet; the original packet is a prefix of the styled one.
    const prefix = opening(plain.model).packet.split('\nActor:')[0]!
    expect(opening(styled.model).packet.startsWith(prefix)).toBe(true)
    // And every other request of the run is identical to the unstyled run's.
    const others = (model: Recorder) => model.requests.filter((request) => !isPartyAdvocacy(request, 'plaintiff')).map((request) => request.stage)
    expect(others(styled.model)).toEqual(others(plain.model))
  })

  it('a failed source check on a styled argument withholds the text: the style does not bypass it', async () => {
    const world = cognitionWorld(stores)
    new FrameworkService(world.store).setForMatter(world.matterId, { packId: ontarioCivilPack.id, changedBy: 'Fictional Paralegal', overrides: [] })
    const inner = new PlantedModel()
    const failing: ModelClient = {
      async generateStage(request) {
        if (request.stage === 'crown_opening') throw new Error('The generated argument stated a fact that is not in the admitted evidence.')
        return inner.generateStage(request)
      },
    }
    const engine = new TrialEngineService(world.store, failing)
    const run = engine.createRun({ matterId: world.matterId, caseModelId: world.model.id, config: { ...cognitionConfig({ jurorCognition: undefined, mode: 'screen' }), advocacy: [{ partyId: 'plaintiff', id: 'theatrical_storytelling' }] } }).run
    await expect(engine.runAutonomous(run.id)).rejects.toBeDefined()
    const events = world.store.workflow.listTrialEvents(run.id)
    expect(events.some((event) => event.type === 'public_submission' && event.actorId === 'plaintiff')).toBe(false)
    // The style was not recorded as applied to an argument that was never produced.
    expect(events.some((event) => event.type === 'advocacy_style_applied')).toBe(false)
  })
})
