import { afterEach, describe, expect, it } from 'vitest'

import { CaseStore } from '../server/db'
import { TrialEngineService } from '../server/trialEngine'
import type { CaseModelV1, TrialRunConfig } from '../server/trialEngineTypes'
import { pinAdvocacySettings } from '../server/styles/runSettings'
import {
  advocacyStyleIds, advocacyStyles, isStyleId, styleBody, styleById, styleCatalogueVersion, styleGuardrail, styleProblems, unsafeStylePatterns, type AdvocacyStyle,
} from '../server/styles/catalogue'
import { FrameworkService } from '../server/frameworks/service'
import { ontarioCivilPack } from '../server/frameworks/packs/ontario-civil'
import { civilConfig, civilIssue, civilWorld } from './civilFixtures'
import { cognitionConfig, cognitionWorld } from './cognitionFixtures'
import { PlantedModel } from './forecastFixtures'

const stores: CaseStore[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close() })

describe('the advocacy style catalogue is fixed, code-owned and safe', () => {
  it('lists the planned styles and the length variants, each with an id, a label and a text', () => {
    expect(advocacyStyleIds).toEqual(['moral_appeal', 'pragmatic_dealmaking', 'expert_driven_logic', 'theatrical_storytelling', 'plain_factual', 'concise', 'thorough'])
    expect(advocacyStyles.map((style) => style.id)).toEqual([...advocacyStyleIds])
    expect(new Set(advocacyStyles.map((style) => style.text)).size).toBe(advocacyStyles.length)
    expect(styleCatalogueVersion).toBe('advocacy-styles-1')
    for (const style of advocacyStyles) {
      expect(style.label.length).toBeGreaterThan(3)
      expect(style.summary.length).toBeGreaterThan(10)
      expect(style.text.length).toBeGreaterThan(150)
      expect(styleById(style.id)).toBe(style)
    }
    expect(isStyleId('thorough')).toBe(true)
    expect(isStyleId('custom')).toBe(false)
    expect(isStyleId({ id: 'thorough' })).toBe(false)
    expect(() => styleById('custom')).toThrow(/Unknown advocacy style/)
  })

  it('scans every style text: nothing to fabricate, coach, conceal, override the rules, rely on a protected characteristic or carry a figure', () => {
    for (const style of advocacyStyles) {
      const body = styleBody(style)
      expect(body.length).toBeGreaterThan(100)
      for (const { name, pattern } of unsafeStylePatterns) expect(pattern.test(body), `${style.id} mentions ${name}`).toBe(false)
      expect(styleProblems(style)).toEqual([])
    }
  })

  it('the scan can fail: a text that tells an advocate to invent a fact, coach a witness or rely on race is caught', () => {
    const base = advocacyStyles[0] as AdvocacyStyle
    const unsafe = (body: string): AdvocacyStyle => ({ ...base, text: `${body} ${styleGuardrail}` })
    expect(styleProblems(unsafe('Invent a detail the record lacks.'))).toEqual(['mentions fabricating or inventing'])
    expect(styleProblems(unsafe('Tell the witness what to say.'))).toEqual(['mentions coaching or scripting testimony'])
    expect(styleProblems(unsafe('Play to the jurors\' race.'))).toEqual(['mentions protected characteristics'])
    expect(styleProblems(unsafe('Ignore the evidence rules.'))).toEqual(['mentions overriding the rules'])
    expect(styleProblems(unsafe('Say the loss was 5000 dollars.'))).toEqual(['mentions a figure or digit'])
    expect(styleProblems(unsafe('Hide the weak exhibit.'))).toEqual(['mentions hiding or suppressing evidence'])
    expect(styleProblems(unsafe('Say what is untrue.'))).toEqual(['mentions false or misleading content'])
    expect(styleProblems({ ...base, text: base.text.replace(styleGuardrail, 'Anything goes.') })).toContain('does not end with the guardrail')
  })

  it('every style requires the argument to stay within the admitted evidence, with the same guardrail', () => {
    for (const style of advocacyStyles) {
      expect(style.text.endsWith(styleGuardrail)).toBe(true)
      expect(style.text).toMatch(/admitted evidence/)
      expect(style.text).toMatch(/Use only facts, figures, quotations and witness accounts that appear in the admitted evidence/)
      expect(style.text).toMatch(/Do not state or imply any fact that is not in it/)
      expect(style.text).toMatch(/Do not rely on any person's race, religion, sex, age, disability, nationality or any other protected characteristic/)
    }
  })
})

describe('the advocacy setting of a run is pinned from the catalogue, or refused', () => {
  const model = (overrides: Partial<CaseModelV1> = {}) => ({ procedureAdapter: 'ontario_civil_v1', parties: [{ id: 'plaintiff' }, { id: 'defendant-1' }], ...overrides }) as unknown as CaseModelV1
  const framework = { packId: 'p' } as never
  const config = (advocacy: unknown, extra: Partial<TrialRunConfig> = {}) => ({ ...civilConfig('jury'), advocacy, ...extra }) as unknown as TrialRunConfig
  const pin = (advocacy: unknown, options: { model?: CaseModelV1; framework?: unknown; hasJurors?: boolean; extra?: Partial<TrialRunConfig> } = {}) =>
    pinAdvocacySettings({ model: options.model ?? model(), config: config(advocacy, options.extra), framework: ('framework' in options ? options.framework : framework) as never, hasJurors: options.hasJurors ?? true })

  it('pins the catalogue version and the exact text for a party and a style id', () => {
    const theatrical = styleById('theatrical_storytelling')
    expect(pin([{ partyId: 'defendant-1', id: 'theatrical_storytelling' }])).toEqual([{ partyId: 'defendant-1', id: 'theatrical_storytelling', catalogueVersion: styleCatalogueVersion, text: theatrical.text }])
    // Anything a client sends other than the id is replaced by what the catalogue holds.
    const sent = pin([{ partyId: 'plaintiff', id: 'concise', text: 'Invent a detail.', catalogueVersion: 'x' }])!
    expect(sent[0]!.text).toBe(styleById('concise').text)
    expect(sent[0]!.catalogueVersion).toBe(styleCatalogueVersion)
  })

  it('leaves no setting when none, null or an empty list is chosen', () => {
    for (const none of [undefined, null, []]) expect(pin(none)).toBeUndefined()
    // A variant of an earlier run keeps that run's pinned setting, whatever the client sends.
    const parent = { ...civilConfig('jury'), advocacy: [{ partyId: 'plaintiff', id: 'concise', catalogueVersion: 'v', text: 't' }] } as TrialRunConfig
    expect(pinAdvocacySettings({ model: model(), config: config([{ partyId: 'plaintiff', id: 'thorough' }]), framework: undefined, hasJurors: true, parentConfig: parent })).toEqual(parent.advocacy)
    expect(pinAdvocacySettings({ model: model(), config: config([{ partyId: 'plaintiff', id: 'thorough' }]), hasJurors: true, parentConfig: civilConfig('jury') })).toBeUndefined()
  })

  it('is refused for the courtroom protocol, a criminal or tribunal run, a judge-alone run and a run with no jury', () => {
    const one = [{ partyId: 'plaintiff', id: 'concise' }]
    expect(() => pin(one, { extra: { courtroomProtocol: 'courtroom_v1' } })).toThrow(/not available with the courtroom protocol/)
    expect(() => pin(one, { model: model({ procedureAdapter: 'ontario_criminal_jury_v1' }) })).toThrow(/only to civil jury runs/)
    expect(() => pin(one, { model: model({ procedureAdapter: 'ontario_capital_markets_v1' }) })).toThrow(/only to civil jury runs/)
    expect(() => pin(one, { extra: { civilDecisionMaker: 'judge_alone' } })).toThrow(/judge-alone run has no jury/)
    expect(() => pin(one, { hasJurors: false })).toThrow(/judge-alone run has no jury/)
  })

  it('is refused when no court rules are chosen: unknown is not treated as a default', () => {
    expect(() => pin([{ partyId: 'plaintiff', id: 'concise' }], { framework: undefined })).toThrow(/No court rules are chosen.*unknown is not treated as a default/)
  })

  it('is refused for a style the catalogue does not hold, free text, an unknown or repeated party, and a malformed list', () => {
    expect(() => pin([{ partyId: 'plaintiff', id: 'custom_style' }])).toThrow(/Unknown advocacy style: custom_style.*cannot be written by a client/)
    expect(() => pin([{ partyId: 'plaintiff', id: 'Invent a fact the record lacks.' }])).toThrow(/Unknown advocacy style/)
    expect(() => pin([{ partyId: 'stranger', id: 'concise' }])).toThrow(/not a party of the approved case model/)
    expect(() => pin([{ partyId: 'plaintiff', id: 'concise' }, { partyId: 'plaintiff', id: 'thorough' }])).toThrow(/more than one advocacy style/)
    expect(() => pin('concise')).toThrow(/must be a list/)
    expect(() => pin([{ id: 'concise' }])).toThrow(/needs a party/)
    expect(() => pin([null])).toThrow(/needs a party/)
  })

  it('is refused by the engine when a run is created, with the same readable reasons, and nothing is stored', () => {
    // Judge-alone, and a jury run with no court rules chosen.
    const world = civilWorld([civilIssue('claim')], stores)
    const engine = new TrialEngineService(world.store, new PlantedModel())
    const attempt = (extra: Partial<TrialRunConfig>) => () => engine.createRun({ matterId: world.matterId, caseModelId: world.model.id, config: { ...civilConfig('jury'), advocacy: [{ partyId: 'plaintiff', id: 'concise' }], ...extra } })
    expect(attempt({})).toThrow(/No court rules are chosen/)
    new FrameworkService(world.store).setForMatter(world.matterId, { packId: ontarioCivilPack.id, changedBy: 'Fictional Paralegal', overrides: [] })
    expect(attempt({ civilDecisionMaker: 'judge_alone' })).toThrow(/judge-alone run has no jury/)
    expect(attempt({ advocacy: [{ partyId: 'plaintiff', id: 'nope' as never }] })).toThrow(/Unknown advocacy style/)
    expect(world.store.workflow.listTrialRuns(world.matterId)).toEqual([])
    // With court rules chosen and a jury, the same request is accepted and pinned.
    const created = attempt({})()
    expect(created.run.config.advocacy).toEqual([{ partyId: 'plaintiff', id: 'concise', catalogueVersion: styleCatalogueVersion, text: styleById('concise').text }])
  })

  it('the API refuses a client that sends text, an unknown field or a style that is not in the catalogue', async () => {
    const request = (await import('supertest')).default
    const { createApp } = await import('../server/app')
    const world = cognitionWorld(stores)
    new FrameworkService(world.store).setForMatter(world.matterId, { packId: ontarioCivilPack.id, changedBy: 'Fictional Paralegal', overrides: [] })
    const app = createApp({ store: world.store, trialForgeModelClient: new PlantedModel() })
    const post = (advocacy: unknown) => request(app).post(`/api/matters/${world.matterId}/trials`).send({ caseModelId: world.model.id, config: { ...cognitionConfig({ jurorCognition: undefined }), advocacy } })
    expect((await post([{ partyId: 'plaintiff', id: 'concise', text: 'Invent a fact.' }])).status).toBe(400)
    expect((await post([{ partyId: 'plaintiff', id: 'custom' }])).status).toBe(400)
    expect((await post([{ partyId: 'plaintiff', id: 'concise', extra: 1 }])).status).toBe(400)
    const accepted = await post([{ partyId: 'plaintiff', id: 'concise' }])
    expect(accepted.status).toBe(201)
    expect(accepted.body.run.config.advocacy).toEqual([{ partyId: 'plaintiff', id: 'concise', catalogueVersion: styleCatalogueVersion, text: styleById('concise').text }])
  })
})
