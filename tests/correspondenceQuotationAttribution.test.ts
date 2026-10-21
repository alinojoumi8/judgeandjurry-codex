import { describe, expect, it } from 'vitest'
import { parseGroundingReview } from '../server/grounding'
import { supportedOpeningSource } from '../samples/courtroom-realism/supported-opening'
import { MiniMaxClient } from '../server/minimax'

const words = 'In summary, ExampleCo received no refunds from Cedar Markets.'
const narrative = 'I reviewed the Cedar Markets records and attached the correspondence and my analysis.\n\n' + words
const claim = `Cedar Markets correspondence reproduced in the accounting report states, "${words}" (E-001).`
function check(text = claim, sourceText = narrative, paragraphs = [2], status = 'supported', name = 'Accounting report') {
  return parseGroundingReview(JSON.stringify({ findings: { 'content:1': { status, supportTypes: ['source'], explanation: 'Check the actual quoted words and their attribution.', citations: paragraphs.map(paragraph => ({ exhibitId: 'E-001', paragraph })), recordCitations: [] } } }), [{ id: 'content:1', text }], [{ ...supportedOpeningSource, exhibitId: 'E-001', name, text: sourceText }])
}

describe('a report summary is not a quotation from the underlying correspondent', () => {
  it.each(['supported', 'analysis'])('rejects the exact nested misattribution despite matching report words: %s', status => {
    const review = check(claim, narrative, [1, 2], status)
    expect(review.status).toBe('failed')
    expect(review.errors.join(' ')).toContain('correspondence attribution')
  })
  it.each([
    `The accounting report quotes Cedar Markets correspondence saying "${words}" (E-001).`,
    `The Cedar Markets email quoted in the report states "${words}" (E-001).`,
    `Cedar Markets letter reproduced within the report says "${words}" (E-001).`,
  ])('rejects equivalent nested attribution: %s', text => {
    expect(check(text).status).toBe('failed')
  })
  it.each([
    `The accounting report states "${words}" (E-001).`,
    `The report records its own summary: "${words}" (E-001).`,
  ])('accepts attribution to the actual report: %s', text => {
    expect(check(text).status).toBe('passed')
  })
  it.each([
    `The Cedar Markets email states: "${words}"`,
    `Cedar Markets wrote: “${words}”`,
    `The correspondence from Cedar Markets says: '${words}'`,
  ])('accepts an explicitly attributed reproduced quotation: %s', source => {
    expect(check(claim, source, [1]).status).toBe('passed')
  })
  it('accepts an explicit reproduced email body with its sender', () => {
    const source = `From: Cedar Markets\nTo: Arin\nSubject: Account review\n\n${words}`
    expect(check(claim, source, [2]).status).toBe('failed')
    expect(check(claim, source, [1, 2]).status).toBe('passed')
  })
  it.each([
    `The Pine Markets email states: "${words}"`,
    `My summary of Cedar Markets correspondence: "${words}"`,
    `Cedar Markets never wrote: "${words}"`,
    `The report author states: "${words}"`,
  ])('does not transfer another speaker, a summary or a denied quotation: %s', source => {
    expect(check(claim, source, [1]).status).toBe('failed')
  })
  it('cannot borrow an unselected quotation from elsewhere in the report', () => {
    expect(check(claim, narrative + `\n\nThe Cedar Markets email states: "${words}"`, [2]).status).toBe('failed')
  })
  it('does not borrow a quote from a later correspondence block across a different sender', () => {
    const source = `From: Cedar Markets\nTo: Arin\nSubject: Account\n\nA review is pending.\n\nFrom: Pine Markets\nTo: Arin\nSubject: Different account\n\n${words}`
    expect(check(claim, source, [1, 2, 3, 4]).status).toBe('failed')
  })
  it('preserves a named correspondent introduced after the correspondence noun', () => {
    const candidate = `Correspondence from Cedar Markets reproduced in the report states "${words}" (E-001).`
    expect(check(candidate, `The Pine Markets email states: "${words}"`, [1]).status).toBe('failed')
    expect(check(candidate, `The Cedar Markets email states: "${words}"`, [1]).status).toBe('passed')
  })
  it('does not match a different sender merely because its name contains the claimed name', () => {
    expect(check(claim, `From: Pine Cedar Markets\nTo: Arin\nSubject: Account\n\n${words}`, [1, 2]).status).toBe('failed')
  })
  it('keeps a direct actual-email quotation valid', () => {
    expect(check(`The email states "${words}" (E-001).`, words, [1], 'supported', 'Actual email').status).toBe('passed')
  })
  it.each(['The email', 'Cedar Markets correspondence'])('cannot bypass the report-source boundary with a shorter attribution: %s', subject => {
    expect(check(`${subject} states "${words}" (E-001).`, narrative, [2], 'supported', 'Accounting_report.pdf').status).toBe('failed')
  })
  it('keeps the report as speaker when it merely refers to correspondence', () => {
    expect(check(`The report refers to Cedar Markets correspondence and states "${words}" (E-001).`).status).toBe('passed')
  })
  it('still rejects altered words in an otherwise correctly attributed report quotation', () => {
    expect(check(`The report states "${words.replace('no refunds', 'several refunds')}" (E-001).`).status).toBe('failed')
  })
  it('repairs only the rejected attribution and independently checks the changed draft', async () => {
    const bodies: any[] = []
    const corrected = `The accounting report states "${words}" (E-001).`
    const row = { status: 'supported', supportTypes: ['source'], explanation: 'The quoted words appear in the selected report.', citations: [{ exhibitId: 'E-001', paragraph: 2 }], recordCitations: [] }
    const client = new MiniMaxClient({ provider: 'minimax', apiKey: 'fixture', baseUrl: 'https://fixture.invalid/v1', model: 'fixture', timeoutMs: 1000, maxRetries: 1 }, undefined, async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)))
      const raw = bodies.length === 1 ? { title: '', content: claim, citations: ['E-001'], jurors: [] }
        : bodies.length === 3 ? { repairs: [{ unitId: 'content:1', replacement: corrected }] }
        : { findings: { 'content:1': row } }
      return Response.json({ choices: [{ message: { content: JSON.stringify(raw) } }] })
    })
    const result = await client.generateStage({ stage: 'crown_opening', packet: '', previousTurns: '', evidence: [{ ...supportedOpeningSource, exhibitId: 'E-001', name: 'Accounting report', text: narrative }], groundingRequired: true })
    expect(bodies).toHaveLength(4)
    expect(result.content).toBe(corrected)
    expect(result.grounding?.status).toBe('passed')
    expect(result.grounding?.priorFailures?.[0].errors.join(' ')).toContain('correspondence attribution mismatch')
    expect(result.grounding?.appliedRepairs).toHaveLength(1)
  })
})
