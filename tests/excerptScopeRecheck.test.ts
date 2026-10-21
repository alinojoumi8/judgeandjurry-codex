import { describe, expect, it } from 'vitest'
import { MiniMaxClient, type StageRequest } from '../server/minimax'
import { supportedOpeningSource } from '../samples/courtroom-realism/supported-opening'

const evidence = [{ ...supportedOpeningSource, exhibitId: 'E-001', text: 'The supplied report excerpt records a deposit of $8,000.' }]
const context = 'E-001: primary; selected_extracts; Only this supplied excerpt is available.'
const scoped = 'The supplied report excerpt lists a deposit but does not include a repayment schedule (E-001).'
const widened = "The deposit figure is supported, but the excerpt's silence cannot establish that no repayment schedule appears in the report, since only a selected excerpt is supplied."
const row = { status: 'unsupported', supportTypes: ['source'], explanation: widened, citations: [{ exhibitId: 'E-001', paragraph: 1 }], recordCitations: [] }

async function check(options: { text?: string; final?: boolean; retries?: number; context?: string; explanation?: string; citations?: any[]; separate?: boolean } = {}) {
  const bodies: any[] = []
  const client = new MiniMaxClient({ provider: 'minimax', apiKey: 'fixture', baseUrl: 'https://fixture.invalid/v1', model: 'fixture', timeoutMs: 1000, maxRetries: options.retries ?? 1 }, undefined, async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)))
    return Response.json({ choices: [{ message: { content: JSON.stringify({ findings: {
      'content:1': { ...row, ...(options.explanation ? { explanation: options.explanation } : {}), ...(options.citations ? { citations: options.citations } : {}), ...(bodies.length > 1 && options.final !== false ? { status: 'supported', explanation: 'The supplied excerpt records the deposit and includes no repayment schedule.' } : {}) },
      ...(options.separate ? { 'content:3': { ...row, explanation: 'The alleged payment is not supported.', citations: [] } } : {}),
    } }) } }] })
  })
  const request: StageRequest = { stage: 'crown_opening', packet: '', previousTurns: '', evidence, groundingRequired: true, groundingContext: options.context ?? context }
  const review = await client.reviewGrounding(request, { title: '', content: (options.text ?? scoped) + (options.separate ? '\n\nArin received a payment (E-001).' : ''), citations: ['E-001'], jurors: [] })
  return { review, bodies }
}

describe('excerpt-scoped absence checker recheck', () => {
  it('rechecks the exact saved scope-broadening rejection without changing the draft', async () => {
    const { review, bodies } = await check()
    expect(review.status).toBe('passed'); expect(bodies).toHaveLength(2)
    expect(review.verificationFailures?.[0].errors.join(' ')).toContain(widened)
    expect(bodies[1].messages[1].content).toContain('checker excerpt-scope mismatch')
    expect(bodies[0].messages[1].content.split('Draft units to check:\n')[1]).toBe(bodies[1].messages[1].content.split('Draft units to check:\n')[1])
  })
  it('does not promote a repeated rejection', async () => {
    const { review, bodies } = await check({ final: false })
    expect(review.status).toBe('failed'); expect(bodies).toHaveLength(2)
  })
  it('honors disabled retries', async () => {
    const { review, bodies } = await check({ retries: 0 })
    expect(review.status).toBe('failed'); expect(bodies).toHaveLength(1)
  })
  it.each([
    'The report contains no repayment schedule (E-001).',
    'The supplied report excerpt lists a deposit, but the entire report lacks a repayment schedule (E-001).',
    'The report contains no repayment schedule; only the supplied excerpt was reviewed (E-001).',
    'The supplied report excerpt does not include a repayment schedule, proving Arin never repaid investors (E-001).',
    'The supplied report excerpt does not include a repayment schedule, and the report contains none (E-001).',
  ])('leaves unqualified, broadened and added factual claims rejected: %s', async text => {
    const { review, bodies } = await check({ text })
    expect(review.status).toBe('failed'); expect(bodies).toHaveLength(1)
  })
  it('preserves a source-specific substantive rejection', async () => {
    const { review, bodies } = await check({ explanation: 'The selected excerpt includes a repayment schedule, contradicting the draft.' })
    expect(review.status).toBe('failed'); expect(bodies).toHaveLength(1)
  })
  it.each([{ context: 'E-001: primary; complete_document;' }, { citations: [] }])('requires actual selected-excerpt coverage and verified selectors: %j', async options => {
    const { review, bodies } = await check(options)
    expect(review.status).toBe('failed'); expect(bodies).toHaveLength(1)
  })
  it('preserves a separate substantive rejection without resampling it', async () => {
    const { review, bodies } = await check({ separate: true })
    expect(review.status).toBe('failed'); expect(bodies).toHaveLength(1)
  })
})
