import { describe, expect, it } from 'vitest'
import { parseGroundingReview } from '../server/grounding'
import { supportedOpeningSource } from '../samples/courtroom-realism/supported-opening'
import { MiniMaxClient, type StageRequest } from '../server/minimax'

const evidence = [{ ...supportedOpeningSource, exhibitId: 'E-001', text: 'An affiliation is described.\n\nA disputed reliance account is quoted.' }]
const unit = { id: 'content:1', text: 'I assess the supplied account.' }
const row = (explanation: string, paragraphs = [1]) => ({ status: 'analysis', supportTypes: ['analysis'], explanation, citations: paragraphs.map(paragraph => ({ exhibitId: 'E-001', paragraph })), recordCitations: [] })
describe('checker explanation paragraph references', () => {
  it.each(['See E-001 paragraph 2.', 'See E-001 para. 2.', 'See paragraph 2 of E-001.', 'See E-001:2.', 'See E-001 paragraphs 1–2.', 'See E-001 paragraphs 1 and 2.', 'See E-099 paragraph 1.'])('rejects an explanation locator absent from the selected source citations: %s', explanation => {
    const result = parseGroundingReview(JSON.stringify({ findings: { [unit.id]: row(explanation) } }), [unit], evidence)
    expect(result.status).toBe('failed')
    expect(result.validationErrors?.join(' ')).toContain('checker explanation paragraph reference')
  })
  it.each(['See E-001 paragraph 2.', 'See E-001 paragraphs 1–2.', 'See paragraph 2 of E-001.'])('accepts exact selected references: %s', explanation => {
    expect(parseGroundingReview(JSON.stringify({ findings: { [unit.id]: row(explanation, [1, 2]) } }), [unit], evidence).status).toBe('passed')
  })
  it('corrects a paragraph reference within the same bounded checker retry', async () => {
    let calls = 0
    const client = new MiniMaxClient({ provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:9999/v1', model: 'fixture', timeoutMs: 1000, maxRetries: 1 }, undefined, async () => {
      return Response.json({ choices: [{ message: { content: JSON.stringify({ findings: { [unit.id]: row(++calls === 1 ? 'See E-001 paragraph 2.' : 'See E-001 paragraph 1.') } }) } }] })
    })
    const request: StageRequest = { stage: 'crown_opening', packet: '', previousTurns: '', evidence }
    const result = await client.reviewGrounding(request, { title: '', content: unit.text, citations: [], jurors: [] })
    expect(calls).toBe(2)
    expect(result.status).toBe('passed')
    expect(result.verificationFailures?.[0].errors.join(' ')).toContain('checker explanation paragraph reference')
  })
})
