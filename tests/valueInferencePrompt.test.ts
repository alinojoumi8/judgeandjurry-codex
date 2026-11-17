import { describe, expect, it } from 'vitest'
import { MiniMaxClient } from '../server/minimax'
import { parseGroundingReview, type GroundingUnit } from '../server/grounding'
import { supportedOpeningSource } from '../samples/courtroom-realism/supported-opening'

const approved = [{ issueId: 'fictional-value', elements: [{ label: 'The value exceeds $1,500', burden: 'Crown must prove beyond a reasonable doubt' }] }]
const evidence = [{ ...supportedOpeningSource, exhibitId: 'E-001', text: 'The report records an account balance of $8,200. The currency is not specified.' }]
const positive = 'The value allegation exceeds $1,500: the report records an account balance of $8,200; its currency is not specified (E-001).'
const conditional = 'The report records an account balance of $8,200; its currency is not specified (E-001). If that balance is established as the value of the subject matter in the currency of the approved element, it could support the proposed value element; the connection and the remaining elements still require proof.'
const sourceFinding = { unitId: 'content:1', status: 'analysis', supportTypes: ['source', 'analysis'], explanation: 'The source supplies the attributed balance; the connection to the approved value element remains conditional.', citations: [{ exhibitId: 'E-001', paragraph: 1 }], recordCitations: [] }

describe('qualified value inference guidance', () => {
  it('permits a source-backed conditional argument while withholding a positive allegation-value conclusion from the same balance', () => {
    const check = (text: string) => parseGroundingReview(JSON.stringify({ findings: [sourceFinding] }), [{ id: 'content:1', text }], evidence, '', undefined, { packet: '', events: [], actorRoles: [], partyRoles: [], approvedIssueInstructions: approved })
    expect(check(conditional).errors).toEqual([])
    expect(check(conditional).findings[0]).toMatchObject({ status: 'analysis', supportTypes: ['source', 'analysis'] })
    const rejected = check(positive)
    expect(rejected.status).toBe('failed')
    expect(rejected.validationErrors?.some(error => error.includes('positive allegation-value conclusion'))).toBe(true)
  })

  it('sends separate author and checker guidance and retains the closed model and conditional guidance in the repair user context', async () => {
    const authorPrompts: string[] = [], checkerPrompts: string[] = []
    let authorCalls = 0
    const client = new MiniMaxClient({ provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1', model: 'fixture', timeoutMs: 1000, maxRetries: 1 }, undefined, async (_url, init) => {
      const body = JSON.parse(String(init?.body))
      const prompt = body.messages[1].content as string
      let response: unknown
      if (prompt.includes('Draft units to check:\n')) {
        checkerPrompts.push(prompt)
        const units = JSON.parse(prompt.split('Draft units to check:\n')[1]) as GroundingUnit[]
        response = { findings: units.map(unit => unit.id.startsWith('content:')
          ? { ...sourceFinding, unitId: unit.id, ...(authorCalls === 1 ? { status: 'unsupported', explanation: 'The recorded balance and unknown currency do not establish the positive allegation-value conclusion.' } : {}) }
          : { unitId: unit.id, status: 'analysis', supportTypes: ['analysis'], explanation: 'This is a heading.', citations: [], recordCitations: [] }) }
      } else {
        authorCalls++
        authorPrompts.push(prompt)
        response = authorCalls === 1 ? { title: 'Value submission', content: positive, citations: [], jurors: [] }
          : { repairs: [{ unitId: 'content:1', replacement: conditional }] }
      }
      return Response.json({ choices: [{ message: { content: JSON.stringify(response) } }] })
    })
    const result = await client.generateStage({ stage: 'crown_opening', packet: 'Actor: crown', evidence, previousTurns: '', groundingRequired: true, approvedIssueInstructions: approved })
    expect(authorPrompts).toHaveLength(2)
    for (const prompt of authorPrompts) {
      expect(prompt).toContain('Value-inference contract:')
      expect(prompt).toContain('if the recorded figure is established as the value of the alleged subject matter')
      expect(prompt).toContain('independent verification, corroboration and net loss are not new required elements')
      expect(prompt).toContain(JSON.stringify(approved))
      expect(prompt).toContain('Do not add, replace or remove a required element')
    }
    expect(authorPrompts[1]).toContain('OUTPUT CONTRACT FOR THIS REPAIR')
    expect(authorPrompts[1]).toContain(positive)
    expect(checkerPrompts.length).toBeGreaterThanOrEqual(2)
    for (const prompt of checkerPrompts) {
      expect(prompt).toContain('Value-inference audit: assess a leading allegation-value conclusion separately')
      expect(prompt).toContain('permit an explicitly conditional connection to the approved value element')
      expect(prompt).toContain('Do not turn source uncertainty into a new independent-verification, corroboration or net-loss element')
      expect(prompt).toContain(JSON.stringify(approved))
    }
    expect(result.content).toBe(conditional)
    expect(result.title).toBe('Value submission')
    expect(result.grounding?.status).toBe('passed')
    expect(result.grounding?.priorFailures?.[0].findings.some(finding => finding.status === 'unsupported')).toBe(true)
  })
})
