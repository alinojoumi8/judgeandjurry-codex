import { afterEach, describe, expect, it } from 'vitest'

import { fictionalLegalPacket, legalPacketReadiness, packetContentHash, placeholderLawPattern } from '../server/legalPacket'
import { legalPacketSchema } from '../server/legalPacketSchema'
import { TrialEngineService } from '../server/trialEngine'
import type { CaseModelV1 } from '../server/trialEngineTypes'
import { civilConfig, civilWorld, ScriptedCivilModel } from './civilFixtures'
import type { CaseStore } from '../server/db'

const stores: CaseStore[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close() })

const criminal = {
  procedureAdapter: 'ontario_criminal_jury_v1', parties: [{ id: 'crown' }, { id: 'accused' }],
  decisionIssues: [{ id: 'count', respondingPartyIds: ['accused'], elements: [{ id: 'element', label: 'Fictional required act', burden: 'Beyond reasonable doubt' }], permittedOutcomes: ['guilty', 'not_guilty', 'no_verdict'] }],
} as unknown as CaseModelV1

const civil = {
  procedureAdapter: 'ontario_civil_v1', parties: [{ id: 'plaintiff' }, { id: 'defendant-1' }],
  decisionIssues: [{ id: 'claim', respondingPartyIds: ['defendant-1'], elements: [{ id: 'claim-element', label: 'Fictional duty', burden: 'Balance of probabilities' }], permittedOutcomes: ['proved', 'not_proved', 'no_decision'] }],
} as unknown as CaseModelV1

describe('legal packets for civil proceedings', () => {
  it('accepts a civil packet with an attestation against its exact hash', () => {
    const packet = fictionalLegalPacket(civil)
    expect(packet.proceeding).toBe('ontario_civil_v1')
    expect(legalPacketSchema.safeParse(packet).success).toBe(true)
    expect(legalPacketReadiness({ ...civil, legalPacket: packet })).toMatchObject({ ready: true, legallyValidated: false, reviewKind: 'fictional_fixture', errors: [] })
  })

  it('keeps criminal packets exactly as they were (valid control)', () => {
    const packet = fictionalLegalPacket(criminal)
    expect(packet.proceeding).toBe('ontario_criminal_jury_v1')
    expect(legalPacketReadiness({ ...criminal, legalPacket: packet })).toMatchObject({ ready: true, errors: [] })
    expect(legalPacketReadiness(criminal).errors).toContain('A reviewed legal packet is required.')
  })

  it('refuses a packet whose proceeding is not the model\'s, in both directions', () => {
    const civilPacket = fictionalLegalPacket(civil)
    const criminalPacket = fictionalLegalPacket(criminal)
    expect(legalPacketReadiness({ ...criminal, legalPacket: civilPacket }).errors).toContain('Packet proceeding does not match the pinned case model.')
    expect(legalPacketReadiness({ ...civil, legalPacket: criminalPacket }).errors).toContain('Packet proceeding does not match the pinned case model.')
  })

  it('still rejects an unknown proceeding in the schema', () => {
    const packet = { ...fictionalLegalPacket(civil), proceeding: 'ontario_capital_markets_v1' }
    expect(legalPacketSchema.safeParse(packet).success).toBe(false)
  })

  it('applies the placeholder check and the attestation rule to civil packets', () => {
    const packet = fictionalLegalPacket(civil)
    packet.issues[0].elements[0].text = 'Essential element placeholder'
    packet.contentHash = packetContentHash(packet)
    expect(legalPacketReadiness({ ...civil, legalPacket: packet }).errors.join(' ')).toMatch(/placeholder law/)
    expect(legalPacketReadiness({ ...civil, legalPacket: packet }).errors.join(' ')).toMatch(/attestation/)
    // Control: real-looking text with a matching attestation passes.
    const fresh = fictionalLegalPacket(civil)
    fresh.issues[0].elements[0].text = 'The defendant owed the plaintiff a duty of care.'
    fresh.contentHash = packetContentHash(fresh)
    fresh.review!.packetHash = fresh.contentHash
    expect(legalPacketReadiness({ ...civil, legalPacket: fresh }).errors).toEqual([])
  })

  it('exposes one placeholder pattern that matches placeholder wording only', () => {
    for (const text of ['Essential element placeholder', 'Please confirm the duty', 'To be reviewed by counsel']) expect(placeholderLawPattern.test(text)).toBe(true)
    for (const text of ['The defendant owed a duty of care', 'Reasonable care was not taken']) expect(placeholderLawPattern.test(text)).toBe(false)
  })

  it('does not let a civil packet switch on the criminal courtroom protocol', () => {
    const world = civilWorld(undefined, stores)
    const engine = new TrialEngineService(world.store, new ScriptedCivilModel())
    const config = { ...civilConfig('jury'), courtroomProtocol: 'courtroom_v1' as const }
    expect(() => engine.createRun({ matterId: world.matterId, caseModelId: world.model.id, config })).toThrow(/criminal jury proceedings only/)
    // Control: the same model starts an ordinary civil run.
    expect(engine.createRun({ matterId: world.matterId, caseModelId: world.model.id, config: civilConfig('jury') }).run.status).toBeDefined()
  })
})
