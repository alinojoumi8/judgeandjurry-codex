import { describe, expect, it } from 'vitest'
import { groundingMessages, parseGroundingReview, sourceParagraphs } from '../server/grounding'
import { MiniMaxClient } from '../server/minimax'
import { supportedOpeningSource } from '../samples/courtroom-realism/supported-opening'

const quote = 'Our client holds no monies for him or any other member of the public in any jurisdiction.'
const source = { ...supportedOpeningSource, exhibitId: 'E-002', name: 'Private fictional account', text:
  'I, Cedar Vale, of Alder MAKE OATH AND SAY:\n\nI received a letter from Rowan Reed, counsel for Lumen Markets. The letter states: “' + quote + '”\n\n205\n\nA separate readable passage describes a disputed signature report.' }
const units = [{ id: 'content:1', text: 'Counsel wrote “' + quote + '” (E-002, paragraph 2).' }]
const findings = (paragraph: number) => JSON.stringify({ findings: [{ unitId: 'content:1', status: 'supported', supportTypes: ['source'], explanation: 'Attributes the selected counsel quotation, without adopting its truth.', citations: [{ exhibitId: 'E-002', paragraph }], recordCitations: [] }] })

describe('correspondence and image-only reference guidance', () => {
  it('keeps a verified counsel quotation usable without resolving an unnamed client', () => {
    expect(parseGroundingReview(findings(2), units, [source]).status).toBe('passed')
  })
  it('keeps an unsupported identity substitution rejected', () => {
    const draft = [{ id: 'content:1', text: 'Vale recorded counsel’s statement that Lumen Markets held no monies for Vale or the public (E-002, paragraph 2).' }]
    expect(parseGroundingReview(findings(2), draft, [source]).status).toBe('failed')
  })
  it('never promotes an image-page label into source support', () => {
    const review = parseGroundingReview(findings(3), units, [source])
    expect(review.status).toBe('failed')
    expect(review.validationErrors?.join(' ')).toContain('paragraph 3 is unavailable')
  })
  it.each([false, true])('shows non-selectable locators without dropping any source text (correction=%s)', correction => {
    const messages = groundingMessages(units, [source], 'Page 3 has sparse extraction; the original is preserved.', undefined, false, undefined, undefined, correction)
    expect(messages[0].content).toContain('Non-selectable text locators: [{"exhibitId":"E-002","paragraph":3}]')
    expect(messages[0].content).toContain('do not invent OCR or authenticate an image')
    for (const paragraph of sourceParagraphs(source)) expect(messages[1].content).toContain(`[E-002 paragraph ${paragraph.paragraph}] ${paragraph.text}`)
    expect(messages[0].content).not.toContain(quote)
  })
  it('does not mark a short but sufficient actual passage non-selectable', () => {
    const messages = groundingMessages(units, [{ ...source, text: 'A valid factual passage.' }], '')
    expect(messages[0].content).not.toContain('Non-selectable text locators:')
  })
  it('guides the civil author to preserve counsel identity terms and extraction scope', async () => {
    let body: any
    const client = new MiniMaxClient({ provider: 'minimax', apiKey: 'fixture', model: 'MiniMax-M3', baseUrl: 'https://example.invalid/v1', timeoutMs: 1000, maxRetries: 0 }, undefined, async (_url, init) => {
      body = JSON.parse(String(init?.body))
      return Response.json({ choices: [{ message: { content: JSON.stringify({ title: 'Submission', content: 'I reserve the position.', citations: [], jurors: [] }) } }] })
    })
    await client.generateStage({ stage: 'defence_opening', civilMotionHearing: true, packet: '', previousTurns: '', evidence: [source] })
    const prompt = JSON.stringify(body.messages)
    expect(prompt).toContain('preserve terms such as our client, your client and him in a direct quotation')
    expect(prompt).toContain('never use a numeric page label on an image-only page as factual support')
    expect(body.thinking).toEqual({ type: 'disabled' })
  })
})
