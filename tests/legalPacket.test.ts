import { describe, expect, it } from 'vitest'
import { legalPacketReadiness, packetContentHash, fictionalLegalPacket } from '../server/legalPacket'
import type { CaseModelV1 } from '../server/trialEngineTypes'
const model = { procedureAdapter: 'ontario_criminal_jury_v1', parties: [{ id: 'crown' }, { id: 'accused' }], decisionIssues: [{ id: 'count', respondingPartyIds: ['accused'], elements: [{ id: 'element', label: 'Fictional required act', burden: 'Beyond reasonable doubt' }], permittedOutcomes: ['guilty', 'not_guilty', 'no_verdict'] }] } as CaseModelV1
describe('pinned legal packet readiness', () => {
  it('blocks missing packets and accepts only explicitly fictional review fixtures for development', () => {
    expect(legalPacketReadiness(model).errors).toContain('A reviewed legal packet is required.')
    const packet = fictionalLegalPacket(model)
    expect(legalPacketReadiness({ ...model, legalPacket: packet })).toMatchObject({ ready: true, legallyValidated: false, reviewKind: 'fictional_fixture' })
  })
  it('rejects changed packets, mismatched jurisdiction, omitted elements and unreviewed authorities', () => {
    const packet = fictionalLegalPacket(model)
    packet.instructions[0].text += ' Modified after review.'
    expect(legalPacketReadiness({ ...model, legalPacket: packet }).errors.join(' ')).toMatch(/hash/)
    packet.contentHash = packetContentHash(packet)
    packet.review!.packetHash = packet.contentHash
    packet.authorities[0].jurisdiction = 'Wrong jurisdiction'
    packet.authorities[0].reviewed = false
    packet.issues[0].elements = []
    const result = legalPacketReadiness({ ...model, legalPacket: packet })
    expect(result.errors.join(' ')).toMatch(/jurisdiction/)
    expect(result.errors.join(' ')).toMatch(/element/)
    expect(result.errors.join(' ')).toMatch(/review/)
  })
  it('rejects placeholder law, unknown burden parties and misplaced authority/issue identities', () => {
    const packet = fictionalLegalPacket(model)
    packet.issues[0].elements[0].text = 'Essential element placeholder'
    packet.issues[0].elements[0].burdenPartyId = 'stranger'
    packet.issues[0].elements[0].authorityIds = ['missing']
    packet.issues[0].respondingPartyIds = ['other']
    packet.issues[0].outcomes = ['unexpected']
    packet.authorities.push({ ...packet.authorities[0] })
    packet.instructions = packet.instructions.slice(1)
    packet.contentHash = packetContentHash(packet); packet.review!.packetHash = packet.contentHash
    const errors = legalPacketReadiness({ ...model, legalPacket: packet }).errors.join(' ')
    expect(errors).toMatch(/placeholder/); expect(errors).toMatch(/burden party/); expect(errors).toMatch(/authority/); expect(errors).toMatch(/party identities/); expect(errors).toMatch(/outcomes/); expect(errors).toMatch(/unique/); expect(errors).toMatch(/duties/)
    packet.review = undefined
    expect(legalPacketReadiness({ ...model, legalPacket: packet }).errors.join(' ')).toMatch(/attestation/)
  })
})
