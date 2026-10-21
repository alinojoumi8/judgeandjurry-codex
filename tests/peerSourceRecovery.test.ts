import { describe, expect, it } from 'vitest'
import { parseGroundingReview, groundingRepairInstructions } from '../server/grounding'
import { groundingTool, groundingCorrectionTool, groundingSingleTool } from '../server/groundingFormat'
import { MiniMaxClient } from '../server/minimax'
import { namedPeerReferenceCandidates } from '../server/groundingRecords'
import { supportedOpeningSource } from '../samples/courtroom-realism/supported-opening'

const source = { ...supportedOpeningSource, exhibitId: 'E-001', text: 'The report labels contributors as "Reviewed Contributors" and "Unreviewed Contributors".' }
const peer = { eventId: 'visible-eight', type: 'juror_deliberation_turn', actorId: 'juror-08', payload: { contribution: 'The contributor categories leave my knowledge doubts unresolved.' } }
const other = { ...peer, eventId: 'visible-seven', actorId: 'juror-07' }
const instruction = { eventId: 'visible-instruction', type: 'judicial_instruction', actorId: 'judge', payload: { text: 'Assess the supplied fictional issue.' } }
const row = { status: 'analysis', supportTypes: ['record', 'source'], explanation: 'The peer point and source labels have separate speakers.', citations: [{ exhibitId: 'E-001', paragraph: 1 }], recordCitations: [{ eventId: 'record:3' }] }
const request = { stage: 'jury_deliberation' as const, packet: '', previousTurns: '', evidence: [source], courtroomActor: { id: 'juror-02', roles: ['juror'], name: 'Juror 2' }, courtroomEvents: [instruction, other, peer] }
const text = 'Juror-08’s point reinforces my concern (record:3). E-001 classifies contributors as “Reviewed Contributors” and “Unreviewed Contributors” (E-001).'
function check(candidate = text, finding = row) {
  return parseGroundingReview(JSON.stringify({ findings: { 'content:1': finding } }), [{ id: 'content:1', text: candidate }], [source], '', undefined, { packet: '', events: request.courtroomEvents, actorRoles: ['juror'], partyRoles: [], stage: 'jury_deliberation', actor: request.courtroomActor })
}

describe('source/peer attribution recovery', () => {
  it.each(['classifies', 'classify', 'classified', 'categorizes', 'categorised'])('keeps source labels after a peer point with reporting verb %s', verb => {
    expect(check(text.replace('classifies', verb)).errors).toEqual([])
  })
  it('still checks both source labels rather than accepting every quotation after a source introduction', () => {
    expect(check(text.replace('Unreviewed Contributors', 'Invented Contributors')).status).toBe('failed')
  })
  it('does not borrow source labels for an actual peer quotation', () => {
    expect(check('Juror-08 said “Reviewed Contributors” (E-001).').status).toBe('failed')
  })
  it('keeps a later actual peer quotation bound to the named peer', () => {
    expect(check(text + ' Juror-08 said “Reviewed Contributors”.').status).toBe('failed')
  })
  it('does not silently replace a wrong peer selector', () => {
    const review = check(text, { ...row, recordCitations: [{ eventId: 'record:2' }] })
    expect(review.status).toBe('failed')
    expect(review.peerReferenceValidationUnitIds).toContain('content:1')
    expect(review.findings[0].recordCitations?.[0].actorId).toBe('juror-07')
  })
  it('does not treat an eligible peer reference as proof of an invented quotation', () => {
    expect(check('Juror-08 said “Receipt was proved beyond doubt”.').status).toBe('failed')
  })
  it('excludes withheld peers and preserves the original record numbering', () => {
    expect(namedPeerReferenceCandidates([{ id: 'content:1', text: 'Juror-07 and juror-08 raised points.' }], [instruction, { ...other, payload: { ...other.payload, withheld: true } }, peer])).toEqual([{ unitId: 'content:1', records: [{ reference: 'record:2', actorId: 'juror-08' }] }])
  })
  it('leaves an unavailable named peer without a replacement candidate', () => {
    expect(namedPeerReferenceCandidates([{ id: 'content:1', text: 'Juror-09 raised a point.' }], request.courtroomEvents)).toEqual([{ unitId: 'content:1', records: [] }])
    expect(check(text.replaceAll('Juror-08', 'Juror-09')).status).toBe('failed')
  })
  it('uses exact named-peer candidate choices on initial and corrected checks', async () => {
    const bodies: any[] = []
    const client = new MiniMaxClient({ provider: 'minimax', apiKey: 'fixture', baseUrl: 'https://fixture.invalid/v1', model: 'fixture', timeoutMs: 1000, maxRetries: 1 }, undefined, async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)))
      const finding = bodies.length === 1 ? { ...row, recordCitations: [{ eventId: 'record:2' }] } : row
      return Response.json({ choices: [{ message: { content: JSON.stringify(bodies.length === 1 ? { findings: { 'content:1': finding } } : { unitId: 'content:1', ...finding }) } }] })
    })
    const review = await client.reviewGrounding(request, { title: '', content: text, citations: ['E-001'], jurors: [] })
    expect(bodies).toHaveLength(2)
    expect(review.status).toBe('passed')
    const properties = bodies[0].tools[0].function.parameters.properties.findings.properties['content:1'].properties
    expect(properties.recordCitations.items.properties.eventId.enum).toEqual(['record:1', 'record:3'])
    for (const body of bodies) {
      expect(body.messages[1].content).toContain('Named-peer reference candidates by unit')
      expect(body.messages[1].content).toContain('"reference":"record:3","actorId":"juror-08"')
    }
    expect(review.findings[0].recordCitations?.[0].eventId).toBe(peer.eventId)
    expect(review.verificationFailures?.[0].findings?.[0].recordCitations?.[0].actorId).toBe('juror-07')
  })
})

describe('complete checker rows before judgments', () => {
  it.each(['keyed', 'array', 'single'])('requires explicit reference/domain selections before status: %s', shape => {
    const units = [{ id: 'content:1', text }], refs = { records: ['record:1'], exhibits: ['E-001'] }
    const tool = shape === 'single' ? groundingSingleTool(units, refs) : shape === 'array' ? groundingCorrectionTool(units, refs) : groundingTool(units, refs)
    const params: any = tool.function.parameters
    const finding = shape === 'single' ? params : shape === 'array' ? params.properties.findings.items : params.properties.findings.properties['content:1']
    const keys = Object.keys(finding.properties)
    expect(keys.indexOf('recordCitations')).toBeLessThan(keys.indexOf('status'))
    expect(keys.indexOf('supportTypes')).toBeLessThan(keys.indexOf('status'))
    expect(finding.required).toEqual(keys)
  })
  it('preserves an omitted negative supportTypes without supplying a default', () => {
    const finding: any = { ...row, status: 'unsupported', explanation: 'The asserted receipt has no source support.', citations: [], recordCitations: [] }
    delete finding.supportTypes
    const review = check('Arin received the payment.', finding)
    expect(review.status).toBe('failed')
    expect(review.findings[0].supportTypes).toBeUndefined()
    expect(review.errors.join(' ')).toContain('omitted supportTypes')
  })
  it('completes a mixed multi-unit negative review on the same draft without reversing its rejection', async () => {
    const bodies: any[] = []
    const supported = { ...row, supportTypes: ['source'], status: 'supported', recordCitations: [] }
    const rejected = { status: 'unsupported', explanation: 'No selected source records this receipt.', citations: [], recordCitations: [] }
    const client = new MiniMaxClient({ provider: 'minimax', apiKey: 'fixture', baseUrl: 'https://fixture.invalid/v1', model: 'fixture', timeoutMs: 1000, maxRetries: 1 }, undefined, async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)))
      const findings = bodies.length === 1 ? { 'content:1': supported, 'content:2': rejected } : [{ unitId: 'content:1', ...supported }, { unitId: 'content:2', ...rejected, supportTypes: ['source'] }]
      return Response.json({ choices: [{ message: { content: JSON.stringify({ findings }) } }] })
    })
    const review = await client.reviewGrounding({ ...request, courtroomEvents: [] }, { title: '', content: 'E-001 labels contributors as “Reviewed Contributors” (E-001). Arin received a payment.', citations: ['E-001'], jurors: [] })
    expect(bodies).toHaveLength(2)
    expect(review.status).toBe('failed')
    expect(review.errors.join(' ')).not.toContain('omitted supportTypes')
    expect(review.findings[1].status).toBe('unsupported')
    expect(review.findings[1].supportTypes).toEqual(['source'])
    expect(review.verificationFailures?.[0].findings?.[1].supportTypes).toBeUndefined()
    const fields = Object.keys(bodies[1].tools[0].function.parameters.properties.findings.items.properties)
    expect(fields).toEqual(['unitId', 'recordCitations', 'citations', 'supportTypes', 'status', 'explanation'])
    expect(bodies[0].messages[1].content.split('Draft units to check:\n')[1]).toBe(bodies[1].messages[1].content.split('Draft units to check:\n')[1])
  })
})

describe('quotation repair fidelity', () => {
  const transcript = { ...source, text: 'Fictional interview\nPage 3\n9 \tQ. \tWhat return was discussed?\n10 \tA. \tThey told me twenty percent.\n11 \tGuaranteed twenty percent.\n12 \tQ. \tWhen?' }
  const quote = (words: string) => `E-001 records “${words}” (E-001).`
  const draft = quote('They told me twenty percent. / Guaranteed twenty percent.')
  const finding = { ...row, status: 'supported', supportTypes: ['source'], recordCitations: [] }
  const audit = (content: string) => parseGroundingReview(JSON.stringify({ findings: { 'content:1': finding } }), [{ id: 'content:1', text: content }], [transcript])
  it('rejects an inserted slash without changing the rejected words', () => {
    const review = audit(draft)
    expect(review.status).toBe('failed')
    expect(review.findings[0].text).toBe(draft)
    expect(groundingRepairInstructions(review)).toContain('Do not insert a slash')
  })
  it.each(['They told me twenty percent. Guaranteed twenty percent.', 'They told me … Guaranteed twenty percent.'])('accepts faithful continuity or explicit omission: %s', words => {
    expect(audit(quote(words)).status).toBe('passed')
  })
  it('checks the author repair independently and preserves the original failure', async () => {
    const bodies: any[] = [], corrected = quote('They told me twenty percent. Guaranteed twenty percent.')
    const client = new MiniMaxClient({ provider: 'minimax', apiKey: 'fixture', baseUrl: 'https://fixture.invalid/v1', model: 'fixture', timeoutMs: 1000, maxRetries: 1 }, undefined, async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)))
      const output = bodies.length === 1 ? { title: '', content: draft, citations: ['E-001'], jurors: [] } : bodies.length === 3 ? { repairs: [{ unitId: 'content:1', replacement: corrected }] } : { findings: { 'content:1': finding } }
      return Response.json({ choices: [{ message: { content: JSON.stringify(output) } }] })
    })
    const result = await client.generateStage({ stage: 'crown_opening', packet: '', previousTurns: '', evidence: [transcript], groundingRequired: true })
    expect(bodies).toHaveLength(4)
    expect(bodies[2].messages[1].content).toContain('Do not insert a slash')
    expect(result.content).toBe(corrected)
    expect(result.grounding?.status).toBe('passed')
    expect(result.grounding?.priorFailures?.[0].findings[0].text).toBe(draft)
  })
  it('withholds a repair that still inserts a slash even if its checker says supported', async () => {
    let calls = 0
    const client = new MiniMaxClient({ provider: 'minimax', apiKey: 'fixture', baseUrl: 'https://fixture.invalid/v1', model: 'fixture', timeoutMs: 1000, maxRetries: 1 }, undefined, async () => {
      calls++
      const output = calls === 1 ? { title: '', content: draft, citations: ['E-001'], jurors: [] } : calls === 3 ? { repairs: [{ unitId: 'content:1', replacement: draft }] } : { findings: { 'content:1': finding } }
      return Response.json({ choices: [{ message: { content: JSON.stringify(output) } }] })
    })
    await expect(client.generateStage({ stage: 'crown_opening', packet: '', previousTurns: '', evidence: [transcript], groundingRequired: true })).rejects.toThrow(/Source verification rejected/)
    expect(calls).toBe(4)
  })
})
