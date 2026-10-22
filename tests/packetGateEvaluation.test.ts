import { describe, expect, it } from 'vitest'
import { rejectsInvalidPacket } from '../scripts/packetGateEvaluation'
import { createCourtroomFixture, ScriptedCourtroomModel } from '../samples/courtroom-realism/fixture'
import { legalPacketReadiness } from '../server/legalPacket'

describe('packet-gate evaluation evidence', () => {
  it('accepts the actual invalid-hash rejection with an otherwise valid ledger and config', () => {
    const f = createCourtroomFixture(new ScriptedCourtroomModel())
    try {
      const defect = f.store.workflow.createCaseModel({ ...f.model, legalPacket: { ...f.model.legalPacket!, contentHash: 'bad' } })
      const errors = legalPacketReadiness(defect).errors
      expect(errors).toContain('Packet content hash does not match its content.')
      expect(rejectsInvalidPacket(() => f.engine.createRun({ matterId: f.matter.id, caseModelId: defect.id, admissionLedgerId: f.run.admissionLedgerId, config: f.run.config }), errors)).toBe(true)
    } finally { f.store.close() }
  })
  it.each(['Admission ledger not found.', 'Database is unavailable.', 'Invalid input schema.', 'Packet content hash does not match its content. Unexpected database failure.'])('does not count an unrelated exception as a passing gate: %s', message => {
    expect(rejectsInvalidPacket(() => { throw new Error(message) }, ['Packet content hash does not match its content.', 'A review attestation against this exact packet hash is required.'])).toBe(false)
  })
  it('does not pass if invalid-packet creation unexpectedly succeeds', () => {
    expect(rejectsInvalidPacket(() => ({}), ['Packet content hash does not match its content.'])).toBe(false)
  })
  it('does not evaluate a valid packet as a negative control', () => {
    let called = false
    expect(rejectsInvalidPacket(() => { called = true }, [])).toBe(false)
    expect(called).toBe(false)
  })
})
