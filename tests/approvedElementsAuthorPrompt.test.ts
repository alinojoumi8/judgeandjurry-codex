import { describe, expect, it } from 'vitest'
import { MiniMaxClient } from '../server/minimax'
import type { GroundingUnit } from '../server/grounding'

const approved = [{ issueId: 'fictional-count', elements: [
  { label: 'A dishonest act', burden: 'Crown must prove beyond a reasonable doubt' },
  { label: 'Economic prejudice caused by the act', burden: 'Crown must prove beyond a reasonable doubt' },
  { label: 'Subjective knowledge of the act', burden: 'Crown must prove beyond a reasonable doubt' },
  { label: 'Subjective knowledge of the economic risk', burden: 'Crown must prove beyond a reasonable doubt' },
  { label: 'The value exceeds $5,000', burden: 'Crown must prove beyond a reasonable doubt' },
] }]

describe('approved exercise model in author and repair prompts', () => {
  it('sends the exact closed element list and burdens to the author and retains them through repair', async () => {
    const authorPrompts: string[] = []
    let authorCalls = 0
    const client = new MiniMaxClient({ provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1', model: 'fixture', timeoutMs: 1000, maxRetries: 1 }, undefined, async (_url, init) => {
      const body = JSON.parse(String(init?.body))
      const prompt = body.messages[1].content as string
      const audit = prompt.includes('Draft units to check:\n')
      let response: unknown
      if (audit) {
        const units = JSON.parse(prompt.split('Draft units to check:\n')[1]) as GroundingUnit[]
        response = { findings: units.map(unit => ({ unitId: unit.id, status: authorCalls === 1 && unit.id.startsWith('content:') ? 'unsupported' : 'analysis', explanation: authorCalls === 1 ? 'The supplied model does not add inducement as an independent required element.' : 'The current statement preserves the approved exercise model and assesses unresolved proof.', citations: [], recordCitations: [], supportTypes: ['instruction'] })) }
      } else {
        authorCalls++
        authorPrompts.push(prompt)
        response = authorCalls === 1 ? { title: 'Submission', content: 'The Crown must prove inducement as a separate element.', citations: [], jurors: [] }
          : { repairs: [{ unitId: 'content:1', replacement: 'The supplied knowledge conditions remain unresolved in my assessment.' }] }
      }
      return Response.json({ choices: [{ message: { content: JSON.stringify(response) } }] })
    })
    const result = await client.generateStage({ stage: 'crown_opening', packet: 'Actor: crown', evidence: [], previousTurns: '', groundingRequired: true, approvedIssueInstructions: approved })
    expect(authorPrompts).toHaveLength(2)
    for (const prompt of authorPrompts) {
      expect(prompt).toContain(JSON.stringify(approved))
      expect(prompt).toContain('closed list')
      expect(prompt).toContain('Do not add, replace or remove a required element')
      expect(prompt).toContain('do not turn either into an independent must-prove requirement')
    }
    expect(authorPrompts[1]).toContain('OUTPUT CONTRACT FOR THIS REPAIR')
    expect(result.content).toBe('The supplied knowledge conditions remain unresolved in my assessment.')
    expect(result.grounding?.status).toBe('passed')
    expect(result.grounding?.priorFailures?.[0].findings.some(finding => finding.status === 'unsupported')).toBe(true)
  })
})
