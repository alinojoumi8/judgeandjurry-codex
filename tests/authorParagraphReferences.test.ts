import { describe, expect, it } from 'vitest'
import { parseGroundingReview } from '../server/grounding'
import { MiniMaxClient } from '../server/minimax'
import { supportedOpeningSource } from '../samples/courtroom-realism/supported-opening'

const evidence = [{ ...supportedOpeningSource, exhibitId: 'E-001', text: 'A disputed token account.\n\nA blue token was described.\n\nAn unrelated red token.' }]
const content = 'The report describes a blue token (E-001, paragraphs 1–2).'
const row = (paragraphs = [1, 2], status = 'supported') => ({ status, supportTypes: ['source'], explanation: 'The selected paragraphs describe the account.', citations: paragraphs.map(paragraph => ({ exhibitId: 'E-001', paragraph })), recordCitations: [] })
function check(text = content, paragraphs = [1, 2]) {
  return parseGroundingReview(JSON.stringify({ findings: { 'content:1': row(paragraphs) } }), [{ id: 'content:1', text }], evidence)
}

describe('author paragraph locators', () => {
  it.each([
    'E-001, paragraphs 1–3', 'E-001 paragraphs 1 and 3', 'E-001, para. 3', 'paragraph 3 of E-001', 'E-001:3',
  ])('rejects a prose reference outside the selected support: %s', pointer => {
    const result = check(`The report describes a blue token (${pointer}).`)
    expect(result.status).toBe('failed')
    expect(result.errors.join(' ')).toContain('author paragraph reference')
    expect(result.validationErrors).toEqual([])
  })
  it('accepts matching selections and leaves PDF page locators to their own validator', () => {
    expect(check().errors).toEqual([])
    expect(check('The report describes a blue token (E-001, paragraphs 1–3).', [1, 2, 3]).errors).toEqual([])
    expect(check('The report describes a blue token (E-001).').errors).toEqual([])
  })
  it('treats a source-quoted pointer as reported words, not an author locator', () => {
    const text = 'The report says “See E-001 paragraph 3” (E-001).'
    const source = [{ ...evidence[0], text: 'See E-001 paragraph 3.' }]
    const result = parseGroundingReview(JSON.stringify({ findings: { 'content:1': row([1]) } }), [{ id: 'content:1', text }], source)
    expect(result.errors).toEqual([])
  })
  it('repairs the author locator within its existing author budget and freshly reviews the result', async () => {
    let authors = 0
    const prompts: string[] = []
    const client = new MiniMaxClient({ provider: 'openai-compatible', baseUrl: 'https://fixture.invalid/v1', model: 'fictional', apiKey: 'fixture', maxRetries: 1, timeoutMs: 1000 }, undefined, async (_url, init) => {
      const prompt = JSON.parse(String(init?.body)).messages[1].content as string
      prompts.push(prompt)
      const marker = 'Draft units to check:\n'
      const units = prompt.includes(marker) ? JSON.parse(prompt.split(marker)[1]) as Array<{ id: string }> : undefined
      const value = units ? { findings: Object.fromEntries(units.map(unit => [unit.id, row()])) } : ++authors === 1
        ? { title: '', content: content.replace('1–2', '1–3'), citations: ['E-001'], jurors: [] }
        : { repairs: [{ unitId: 'content:1', replacement: content }] }
      return Response.json({ choices: [{ message: { content: JSON.stringify(value) } }] })
    })
    const result = await client.generateStage({ stage: 'defence_opening', packet: 'Fictional exercise.', previousTurns: '', groundingRequired: true, evidence })
    expect(authors).toBe(2)
    expect(result.content).toBe(content)
    expect(result.grounding?.priorFailures?.[0].errors.join(' ')).toContain('author paragraph reference')
    expect(prompts.at(-1)).toContain(content)
    expect(result.grounding?.status).toBe('passed')
  })
})
