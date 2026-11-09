import { describe, expect, it } from 'vitest'
import { MiniMaxClient, type StageRequest } from '../server/minimax'
import { groundingUnits } from '../server/grounding'

const row = { status: 'analysis', supportTypes: ['analysis'], explanation: 'A current assessment without an added factual premise.', citations: [], recordCitations: [] }
const draft = { title: 'Assessment', content: Array.from({ length: 22 }, (_, i) => `I retain doubt about issue ${i + 1}.`).join('\n\n'), citations: [], jurors: [] }
const units = groundingUnits(draft)
const request: StageRequest = { stage: 'defence_rebuttal', packet: '', previousTurns: '', evidence: [] }
const keyed = () => ({ findings: Object.fromEntries(units.map(u => [u.id, structuredClone(row)])) })
const array = () => ({ findings: units.map(u => ({ unitId: u.id, ...structuredClone(row) })) })
const envelope = (data: unknown) => Response.json({ choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ type: 'function', function: { name: 'record_grounding_review', arguments: JSON.stringify(data) } }] } }] })
const client = (replies: unknown[], bodies: any[] = [], maxRetries = 0) => new MiniMaxClient({ provider: 'minimax', apiKey: 'fictional', baseUrl: 'https://fictional.invalid/v1', model: 'fixture', timeoutMs: 1000, maxRetries }, undefined, async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return envelope(replies[Math.min(bodies.length - 1, replies.length - 1)]) })

describe('MiniMax scalar checker delivery', () => {
  it('requests one scalar field and decodes all 23 explicit keyed assessments on the initial check', async () => {
    expect(units).toHaveLength(23)
    const bodies: any[] = []
    const review = await client([{ reviewJson: JSON.stringify(keyed()) }], bodies).reviewGrounding(request, draft)
    expect(review.status).toBe('passed'); expect(review.findings).toHaveLength(23); expect(bodies).toHaveLength(1)
    expect(bodies[0].tools[0].function.parameters.required).toEqual(['reviewJson'])
    expect(Object.keys(bodies[0].tools[0].function.parameters.properties)).toEqual(['reviewJson'])
    expect(bodies[0].messages[0].content).toContain('only reviewJson')
    expect(bodies[0].messages[1].content).toMatch(/^Stage: factual_verification\n.*only reviewJson/)
    expect(bodies[0].messages[0].content).not.toContain('Do not encode a review inside reviewJson')
  })

  it('uses the same scalar envelope for the one permitted complete correction', async () => {
    const bodies: any[] = []
    const broken = { findings: { [units[0].id]: row, [units[1].id]: { recordCitations: ['eventId>record:2'] } }, status: 'analysis', supportTypes: ['analysis'], explanation: 'A misplaced assessment.', citations: '', item: { unitId: units.at(-1)!.id, ...row } }
    const review = await client([broken, { reviewJson: JSON.stringify(array()) }], bodies, 1).reviewGrounding(request, draft)
    expect(review.status).toBe('passed'); expect(review.findings).toHaveLength(23); expect(bodies).toHaveLength(2)
    expect(review.verificationFailures).toHaveLength(1)
    expect(bodies.every(b => b.tools[0].function.parameters.required.join() === 'reviewJson')).toBe(true)
    expect(bodies[1].messages[1].content).toContain('flat findings array')
  })

  it('keeps an explicitly rejected model finding rejected after decoding', async () => {
    const data = keyed(); data.findings['content:1'].status = 'unsupported'
    const review = await client([{ reviewJson: JSON.stringify(data) }]).reviewGrounding(request, draft)
    expect(review.status).toBe('failed'); expect(review.findings.find(f => f.unitId === 'content:1')?.status).toBe('unsupported')
  })

  it.each(['status', 'supportTypes', 'explanation', 'citations', 'recordCitations'])('does not manufacture a missing %s in an encoded initial array', async field => {
    const data: any = array(); delete data.findings[1][field]
    const review = await client([{ reviewJson: JSON.stringify(data) }]).reviewGrounding(request, draft)
    expect(review.status).toBe('failed')
    expect(review.errors.join(' ')).toContain(field)
  })

  it.each(['missing-id', 'duplicate-id', 'unknown-id', 'empty-review', 'empty-array-string', 'string-record', 'object-support-type', 'bad-json', 'non-string-wrapper', 'extra-wrapper'])('withholds the invalid encoded payload: %s', async mode => {
    const data: any = array()
    if (mode === 'missing-id') delete data.findings[1].unitId
    if (mode === 'duplicate-id') data.findings[1].unitId = data.findings[0].unitId
    if (mode === 'unknown-id') data.findings[1].unitId = 'invented:1'
    if (mode === 'empty-review') data.findings = []
    if (mode === 'empty-array-string') data.findings[1].recordCitations = ''
    if (mode === 'string-record') data.findings[1].recordCitations = ['eventId>record:2']
    if (mode === 'object-support-type') data.findings[1].supportTypes = [{ analysis: true }]
    const inner = mode === 'bad-json' ? '{' : JSON.stringify(data)
    const wrapped = { reviewJson: mode === 'non-string-wrapper' ? data : inner, ...(mode === 'extra-wrapper' ? { status: 'analysis' } : {}) }
    const review = await client([wrapped]).reviewGrounding(request, draft)
    expect(review.status).toBe('failed')
  })

  it('preserves the captured fragmented shape as an invalid response inside a scalar envelope', async () => {
    const fragments = { findings: [{ unitId: units[0].id, ...row }, { unitId: units[1].id, recordCitations: ['eventId>record:2'] }], citations: '', supportTypes: ['analysis'], status: 'analysis', explanation: 'An orphaned assessment.', item: { unitId: units.at(-1)!.id, ...row } }
    const review = await client([{ reviewJson: JSON.stringify(fragments) }]).reviewGrounding(request, draft)
    expect(review.status).toBe('failed')
  })

  it('reads a complete initial unit map directly from the scalar channel', async () => {
    const direct = keyed().findings
    const result = await client([{ reviewJson: JSON.stringify(direct) }]).reviewGrounding(request, draft)
    expect(result.status).toBe('passed')
    expect(result.findings.map(({ unitId, explanation }) => ({ unitId, explanation }))).toEqual(
      units.map(({ id }) => ({ unitId: id, explanation: direct[id].explanation })),
    )
  })

  it.each(['missing-id', 'unknown-id', 'extra-root', 'missing-field', 'duplicate-id', 'duplicate-field', 'unverified-source'])(
    'withholds an incomplete or ambiguous direct map: %s', async mode => {
      const direct: Record<string, any> = keyed().findings
      if (mode === 'missing-id') delete direct['content:1']
      if (mode === 'unknown-id') { direct['content:invented'] = direct['content:1']; delete direct['content:1'] }
      if (mode === 'extra-root') direct.note = 'This text is not a finding.'
      if (mode === 'missing-field') delete direct['content:1'].recordCitations
      if (mode === 'unverified-source') {
        direct['content:1'] = { ...row, status: 'supported', supportTypes: ['source'], citations: [{ exhibitId: 'E-999', paragraph: 1 }] }
      }
      let reviewJson = JSON.stringify(direct)
      if (mode === 'duplicate-id') reviewJson = '{"\\u0074itle:1":' + JSON.stringify(row) + ',' + reviewJson.slice(1)
      if (mode === 'duplicate-field') reviewJson = reviewJson.replace('"content:1":{', '"content:1":{"recordCitations":[],')
      const result = await client([{ reviewJson }]).reviewGrounding(request, draft)
      expect(result.status).toBe('failed')
      if (mode === 'missing-field') expect(result.errors.join(' ')).toContain('recordCitations is required')
      if (mode.startsWith('duplicate-')) expect(result.errors.join(' ')).toContain('duplicate JSON key')
      if (mode === 'unverified-source') expect(result.errors.join(' ')).toContain('E-999')
    },
  )

  it('keeps a scoped single-unit correction explicit inside the scalar channel', async () => {
    const initial: any = keyed(); delete initial.findings['content:1'].recordCitations
    const bodies: any[] = []
    const selected = { unitId: 'content:1', ...row, recordCitations: '[]' }
    const review = await client([initial, { reviewJson: JSON.stringify(selected) }], bodies, 1).reviewGrounding(request, draft)
    expect(review.status).toBe('passed'); expect(review.findings).toHaveLength(23); expect(bodies).toHaveLength(2)
    const requested = JSON.parse(bodies[1].messages[1].content.split('Draft units to check:\n')[1])
    expect(requested.map((u: any) => u.id)).toEqual(['content:1'])
    expect(review.findings.filter(f => f.unitId !== 'content:1').every(f => f.explanation === row.explanation)).toBe(true)
  })

  it('resolves a complete encoded peer selector through the unchanged record authorization check', async () => {
    const events = [{ eventId: 'fictional-peer-event', type: 'juror_deliberation_turn' as const, actorId: 'juror-01', payload: { contribution: 'I remain uncertain.' } }]
    const finding = { ...row, supportTypes: ['record'], explanation: 'The selected peer expressed uncertainty.', recordCitations: [{ eventId: 'record:1' }] }
    const review = await client([{ reviewJson: JSON.stringify({ findings: { 'content:1': finding } }) }]).reviewGrounding({ ...request, stage: 'jury_deliberation', courtroomEvents: events, courtroomActor: { id: 'juror-02', name: 'Juror 2', roles: ['juror'] } }, { title: '', content: 'Juror 1 remains uncertain.', citations: [], jurors: [] })
    expect(review.status).toBe('passed'); expect(review.findings[0].recordCitations?.[0].eventId).toBe('fictional-peer-event')
  })

  it('does not use historical text defaults for an unwrapped tool array with a missing field', async () => {
    const data: any = array(); delete data.findings[1].recordCitations
    const review = await client([data]).reviewGrounding(request, draft)
    expect(review.status).toBe('failed')
    expect(review.errors.join(' ')).toContain('recordCitations is required')
  })

  it('retains complete legacy keyed tool reviews without requiring a new stored representation', async () => {
    expect((await client([keyed()]).reviewGrounding(request, draft)).status).toBe('passed')
  })
})
