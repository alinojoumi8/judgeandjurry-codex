import { describe, expect, it } from 'vitest'
import { MiniMaxClient } from '../server/minimax'
import { groundingTool } from '../server/groundingFormat'
import { supportedOpeningSource } from '../samples/courtroom-realism/supported-opening'

const content = 'Arin received a payment.'
const rejected = { status: 'unsupported', explanation: 'The alleged payment has no source support.', citations: [], recordCitations: [] }

describe('bounded checker completion before author repair', () => {
  it.each(['still-rejected', 'promoted', 'still-missing'])('repairs omitted support metadata on the same draft while retaining rejection: %s', async outcome => {
    const bodies: any[] = []
    const client = new MiniMaxClient({ provider: 'minimax', apiKey: 'fixture', baseUrl: 'https://fixture.invalid/v1', model: 'fixture', timeoutMs: 1000, maxRetries: 1 }, undefined, async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)))
      const row = bodies.length === 1 || outcome === 'still-missing' ? rejected : { ...rejected, supportTypes: ['analysis'], ...(outcome === 'promoted' ? { status: 'analysis', explanation: 'A current assessment.' } : {}) }
      return Response.json({ choices: [{ message: { content: JSON.stringify(bodies.length === 1 ? { findings: { 'content:1': row } } : { unitId: 'content:1', ...row }) } }] })
    })
    const review = await client.reviewGrounding({ stage: 'crown_opening', packet: '', previousTurns: '', evidence: [] }, { title: '', content, citations: [], jurors: [] })
    expect(bodies).toHaveLength(2)
    expect(review.status).toBe('failed')
    expect(bodies[0].messages[1].content.split('Draft units to check:\n')[1]).toBe(bodies[1].messages[1].content.split('Draft units to check:\n')[1])
    expect(review.verificationFailures?.[0].findings?.[0].status).toBe('unsupported')
    if (outcome === 'promoted') expect(review.errors.join(' ')).toContain('checker changed judgment on unchanged text')
    if (outcome === 'still-missing') expect(review.findings[0].supportTypes).toBeUndefined()
  })
  it('requires the full nonempty inventory and explicit metadata in the initial tool', () => {
    const tool = groundingTool([{ id: 'content:1', text: content }], { records: [], exhibits: [] })
    expect(tool.function.parameters.properties.findings.minProperties).toBe(1)
    expect(tool.function.parameters.properties.findings.maxProperties).toBe(1)
    expect(tool.function.parameters.properties.findings.properties['content:1'].properties.supportTypes.description).toContain('unsupported and contradicted')
  })
  it('retains the existing recheck for a mechanically identified scope error even when metadata is missing', async () => {
    let calls = 0
    const client = new MiniMaxClient({ provider: 'minimax', apiKey: 'fixture', baseUrl: 'https://fixture.invalid/v1', model: 'fixture', timeoutMs: 1000, maxRetries: 1 }, undefined, async () => {
      calls++
      const row = { status: calls === 1 ? 'unsupported' : 'supported', explanation: calls === 1 ? "The deposit figure is supported, but the excerpt's silence cannot establish that no repayment schedule appears in the report, since only a selected excerpt is supplied." : 'The supplied excerpt records the deposit and includes no repayment schedule.', citations: [{ exhibitId: 'E-001', paragraph: 1 }], recordCitations: [], ...(calls > 1 ? { supportTypes: ['source'] } : {}) }
      return Response.json({ choices: [{ message: { content: JSON.stringify(calls === 1 ? { findings: { 'content:1': row } } : { unitId: 'content:1', ...row }) } }] })
    })
    const review = await client.reviewGrounding({ stage: 'crown_opening', packet: '', previousTurns: '', groundingContext: 'E-001: primary; selected_extracts; Only this supplied excerpt is available.', evidence: [{ ...supportedOpeningSource, exhibitId: 'E-001', text: 'The supplied report excerpt records a deposit of $8,000.' }] }, { title: '', content: 'The supplied report excerpt lists a deposit but does not include a repayment schedule (E-001).', citations: ['E-001'], jurors: [] })
    expect(calls).toBe(2)
    expect(review.status).toBe('passed')
    expect(review.verificationFailures?.[0].errors.join(' ')).toContain('checker excerpt-scope mismatch')
  })
})
