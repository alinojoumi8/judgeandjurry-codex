import { describe, expect, it } from 'vitest'
import { MiniMaxClient } from '../server/minimax'
import { parseGroundingReview } from '../server/grounding'
import { groundingCorrectionContent, checkerSchemaFailure } from '../server/groundingFormat'

const unit = { id: 'content:1', text: 'Arin received a payment.' }
const rejected = { status: 'unsupported', explanation: 'The alleged payment has no supplied support.', supportTypes: ['analysis'], citations: [], recordCitations: [] }
function parse(row: any, extra: Record<string, unknown> = {}) {
  return parseGroundingReview(groundingCorrectionContent(JSON.stringify({ findings: [{ unitId: unit.id, ...row }], ...extra })), [unit], [])
}

describe('explicit rejected findings with omitted ancillary metadata', () => {
  it.each(['unsupported', 'contradicted'])('preserves %s rejection without inventing omitted support domains or record references', status => {
    const { supportTypes: _, recordCitations: __, ...row } = rejected
    const review = parse({ ...row, status })
    expect(review.status).toBe('failed'); expect(checkerSchemaFailure(review)).toBe(false)
    expect(review.findings[0].status).toBe(status)
    expect(review.findings[0].supportTypes).toBeUndefined()
    expect(review.findings[0].recordCitations).toBeUndefined()
    expect(review.errors.join(' ')).toContain('omitted supportTypes, recordCitations')
  })
  it.each(['status', 'explanation', 'citations'])('still rejects a missing essential field: %s', field => {
    const row: any = { ...rejected }; delete row[field]
    const review = parse(row)
    expect(review.status).toBe('failed'); expect(checkerSchemaFailure(review)).toBe(true)
  })
  it.each(['analysis', 'supported'])('requires every field on a potentially accepted %s row', status => {
    const { recordCitations: _, ...row } = rejected
    const review = parse({ ...row, status })
    expect(review.status).toBe('failed'); expect(checkerSchemaFailure(review)).toBe(true)
  })
  it.each([{ supportTypes: [] }, { supportTypes: ['invented'] }, { recordCitations: '' }, { citations: ['E-001'] }, { unexpected: true }])('does not repair present malformed metadata or unknown fields: %j', change => {
    const review = parse({ ...rejected, ...change })
    expect(review.status).toBe('failed'); expect(checkerSchemaFailure(review)).toBe(true)
  })
  it('retains strict root and exact ID inventory checks', () => {
    expect(checkerSchemaFailure(parse(rejected, { unexpected: true }))).toBe(true)
    const review = parseGroundingReview(groundingCorrectionContent(JSON.stringify({ findings: [{ unitId: 'invented:1', ...rejected }] })), [unit], [])
    expect(review.status).toBe('failed'); expect(checkerSchemaFailure(review)).toBe(true)
  })
  it('allows only the bounded rejected-unit author repair and independently checks the repaired draft', async () => {
    const bodies: any[] = []
    const client = new MiniMaxClient({ provider: 'minimax', apiKey: 'fixture', baseUrl: 'https://fixture.invalid/v1', model: 'fixture', timeoutMs: 1000, maxRetries: 1 }, undefined, async (_url, init) => {
      const body = JSON.parse(String(init?.body)); bodies.push(body)
      const n = bodies.length
      const raw = n === 1 ? { title: '', content: unit.text, citations: [], jurors: [] }
        : n === 2 ? {} : n === 3 ? { findings: [{ unitId: unit.id, status: rejected.status, explanation: rejected.explanation, citations: [] }] }
        : n === 4 ? { repairs: [{ unitId: unit.id, replacement: 'The supplied material leaves this question unresolved.' }] }
        : { findings: { [unit.id]: { ...rejected, status: 'analysis', explanation: 'A qualified current assessment without a factual assertion.' } } }
      return Response.json({ choices: [{ message: { content: JSON.stringify(raw) } }] })
    })
    const result = await client.generateStage({ stage: 'crown_opening', packet: '', previousTurns: '', evidence: [], groundingRequired: true })
    expect(result.grounding?.status).toBe('passed'); expect(bodies).toHaveLength(5)
    expect(result.grounding?.priorFailures?.[0].errors.join(' ')).toContain('omitted supportTypes, recordCitations')
    expect(result.grounding?.priorFailures?.[0].findings[0].status).toBe('unsupported')
    expect(result.grounding?.appliedRepairs).toHaveLength(1)
    expect(result.content).not.toContain(unit.text)
  })
})
