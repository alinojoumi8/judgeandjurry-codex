import { describe, expect, it } from 'vitest'
import { parseGroundingReview } from '../server/grounding'
import type { GroundingRecordEvent } from '../server/groundingRecords'
import { supportedOpeningSource } from '../samples/courtroom-realism/supported-opening'

const leadIns = ['Here, ', 'Finally, ', 'In reply, ', 'Accordingly, ', 'Therefore, ', 'On this record, ', 'For these reasons, ', 'In closing, ']

function audit(text: string, options: { role?: string; source?: string; events?: GroundingRecordEvent[]; records?: string[] } = {}) {
  const role = options.role ?? 'crown'
  const source = { ...supportedOpeningSource, exhibitId: 'E-001', text: options.source ?? 'Mira states: Rowan carried a sealed envelope.' }
  return parseGroundingReview(JSON.stringify({ findings: { 'content:1': { status: 'analysis', supportTypes: ['source', 'analysis'], explanation: 'A current source-based argument or an independently attributed prior statement.', citations: [{ exhibitId: 'E-001', paragraph: 1 }], recordCitations: (options.records ?? []).map(eventId => ({ eventId })) } } }),
    [{ id: 'content:1', text }], [source], '', undefined,
    { packet: '', actor: { id: role }, actorRoles: [role], stage: role === 'crown' ? 'crown_rebuttal' : 'defence_rebuttal',
      partyRoles: [{ id: 'crown', role: 'crown' }, { id: 'defence', role: 'defence' }], events: options.events ?? [] })
}

describe('current advocate clauses are distinct from reports of party positions', () => {
  it.each(['Crown', 'Defence'])('allows %s own present speech with discourse lead-ins and clause boundaries', party => {
    const role = party.toLowerCase()
    for (const prefix of ['', ...leadIns, 'I assess this account; ', 'I assess this account; finally, ', 'I assess this account. Accordingly, ']) {
      const review = audit(`${prefix}the ${party} relies on Mira’s account (E-001).`, { role })
      expect(review.errors).toEqual([])
      expect(review.status).toBe('passed')
    }
  })

  it.each(['Crown', 'Defence'])('does not infer an opposite-party position when the %s is the current author', party => {
    const other = party === 'Crown' ? 'Defence' : 'Crown'
    for (const prefix of [...leadIns, 'I assess this account; ']) {
      expect(audit(`${prefix}the ${other} relies on Mira’s account (E-001).`, { role: party.toLowerCase() }).status).toBe('failed')
    }
  })

  it.each(['Crown', 'Defence'])('requires a real earlier public record for the %s own historical reliance', party => {
    for (const text of [`Earlier, the ${party} relied on Mira’s account (E-001).`, `Here, the ${party} argued from Mira’s account (E-001).`, `I assess this account; the ${party} relied on Mira’s account (E-001).`]) {
      expect(audit(text, { role: party.toLowerCase() }).status).toBe('failed')
    }
    for (const prefix of leadIns) expect(audit(`${prefix}the ${party} relied on Mira’s account (E-001).`, { role: party.toLowerCase() }).status).toBe('failed')
    const event = { eventId: 'actual-earlier-statement', type: 'public_submission', actorId: party.toLowerCase(), payload: { text: `The ${party} relies on Mira’s account.` } }
    expect(audit(`Earlier, the ${party} relied on Mira’s account (E-001).`, { role: party.toLowerCase(), events: [event], records: [event.eventId] }).status).toBe('passed')
  })

  it.each(['Crown', 'Defence'])('does not treat a source report as the %s current speech', party => {
    const source = `The report states that the ${party} relies on Mira’s account.`
    for (const text of [`The report states that the ${party} relies on Mira’s account (E-001).`, `According to the report, the ${party} relies on Mira’s account (E-001).`]) {
      expect(audit(text, { role: party.toLowerCase(), source }).status).toBe('failed')
    }
    for (const prefix of leadIns) expect(audit(`Mira says that ${prefix}the ${party} relies on Mira’s account (E-001).`, { role: party.toLowerCase(), source })).toMatchObject({ status: 'failed' })
  })

  it.each(['Crown', 'Defence'])('does not strip a quoted present %s clause even after a quoted semicolon', party => {
    for (const quotation of [...leadIns.map(prefix => `${prefix}the ${party} relies on Mira’s account`), `The account remains disputed; the ${party} relies on Mira’s account`]) {
      const text = `The report quotes “${quotation}” (E-001).`
      expect(audit(text, { role: party.toLowerCase(), source: `The report quotes “${quotation}”.` }).status).toBe('failed')
    }
    for (const quotation of [`The account remains disputed; the ${party} relies on Mira’s account`, `Mira’s account remains disputed; the ${party} relies on that account`]) {
      expect(audit(`The report quotes ‘${quotation}’ (E-001).`, { role: party.toLowerCase(), source: `The report quotes ‘${quotation}’.` }).status).toBe('failed')
    }
  })

  it('keeps an opposite-party or historical assertion held beside a valid current own clause', () => {
    expect(audit('Here, the Crown relies on Mira’s account; the Defence relies on Mira’s account (E-001).').status).toBe('failed')
    expect(audit('Here, the Crown relies on Mira’s account; the Crown relied on Mira’s account earlier (E-001).').status).toBe('failed')
  })

  it('does not infer current author identity from the clause text', () => {
    expect(audit('Here, the Crown relies on Mira’s account (E-001).', { role: 'judge' }).status).toBe('failed')
  })
})
