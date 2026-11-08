import { describe, expect, it } from 'vitest'
import { MiniMaxClient, type StageRequest } from '../server/minimax'
import { groundingUnits, parseGroundingReview } from '../server/grounding'
import { groundingToolContent, groundingCorrectionUnits, mergeGroundingCorrection } from '../server/groundingFormat'
import { supportedOpeningSource } from '../samples/courtroom-realism/supported-opening'

const coverage = 'The complete signature-expert reports are not supplied in this run. Only attributed summaries in the selected excerpts are available.'
const scopeText = 'Because the complete reports are outside the supplied excerpts, this remains an attributed allegation, not a verified forensic conclusion.'
const draft = { title: '', content: Array.from({ length: 24 }, (_, index) => index === 5 ? scopeText : `I retain doubt about issue ${index + 1}.`).join('\n\n'), citations: [], jurors: [] }
const units = groundingUnits(draft)
const targetId = units.find(unit => unit.text === scopeText)!.id
const assessment = { recordCitations: [], citations: [], supportTypes: ['analysis'], status: 'analysis', explanation: 'A current assessment.' }
const sourceUse = { ...assessment, supportTypes: ['source_use', 'analysis'], explanation: 'The supplied application coverage limits this assessment, not source truth.' }
const bad = { ...assessment, supportTypes: ['source', 'analysis'], status: 'supported', explanation: 'The omitted report and the assessment are source supported.' }
const initial = () => ({ findings: Object.fromEntries(units.map(unit => [unit.id, { ...(unit.id === targetId ? bad : assessment) }])) })
const input: StageRequest = { stage: 'defence_rebuttal', packet: 'Fictional hearing.', previousTurns: '', evidence: [{ ...supportedOpeningSource, text: 'A summary records an attributed opinion.' }], civilMotionHearing: true, groundingContext: coverage }
const config = { provider: 'minimax' as const, model: 'fixture', baseUrl: 'https://example.invalid/v1', apiKey: 'fixture', timeoutMs: 1000, maxRetries: 1 }
const response = (data: unknown, content: string | null = null) => Response.json({ choices: [{ finish_reason: 'tool_calls', message: { content, tool_calls: [{ type: 'function', function: { name: 'record_grounding_review', arguments: JSON.stringify(data) } }] } }] })

function clientWith(second: (body: any) => unknown) {
  const bodies: any[] = []
  const client = new MiniMaxClient(config, undefined, async (_url, init) => { const body = JSON.parse(String(init?.body)); bodies.push(body); return response(bodies.length === 1 ? initial() : second(body)) })
  return { client, bodies }
}

describe('bounded correction of one classification among a complete review', () => {
  it('requests one independently assessed row and retains all other explicit rows', async () => {
    const { client, bodies } = clientWith(body => {
      const selected = JSON.parse(body.messages[1].content.split('Draft units to check:\n')[1])
      expect(selected.map((unit: any) => unit.id)).toEqual([targetId])
      expect(body.tools[0].function.parameters.required).toEqual(['reviewJson'])
      expect(body.messages[1].content).toContain('Complete unchanged draft for context only')
      expect(body.messages[1].content).toContain(units.at(-1)!.id)
      expect(body.messages[1].content).toContain(coverage)
      expect(body.messages[1].content).toContain('Application coverage and omitted-file notes')
      return { unitId: targetId, ...sourceUse }
    })
    const result = await client.reviewGrounding(input, draft)
    expect(result.status).toBe('passed'); expect(bodies).toHaveLength(2)
    expect(result.findings).toHaveLength(24)
    expect(result.findings.find(f => f.unitId === targetId)?.supportTypes).toEqual(['source_use', 'analysis'])
    for (const finding of result.findings.filter(f => f.unitId !== targetId)) {
      expect(finding.status).toBe(assessment.status); expect(finding.explanation).toBe(assessment.explanation)
    }
    expect(result.verificationFailures?.[0].errors.join(' ')).toContain('factual support needs a verified source quotation')
  })
  it('retains the strict invalid classification when no correction is available', async () => {
    const client = new MiniMaxClient({ ...config, maxRetries: 0 }, undefined, async () => response(initial()))
    const result = await client.reviewGrounding(input, draft)
    expect(result.status).toBe('failed')
    expect(result.findings.find(f => f.unitId === targetId)?.supportTypes).toEqual(['source', 'analysis'])
  })
  it.each(['unitId', 'recordCitations', 'citations', 'supportTypes', 'status', 'explanation'])('does not fill an absent correction field: %s', field => {
    const row: Record<string, unknown> = { unitId: targetId, ...sourceUse }; delete row[field]
    const { client, bodies } = clientWith(() => row)
    return client.reviewGrounding(input, draft).then(review => { expect(review.status).toBe('failed'); expect(bodies).toHaveLength(2) })
  })
  it.each(['wrong-id', 'extra-root', 'extra-row', 'empty-findings', 'unknown-source', 'unknown-record', 'unchanged-invalid'])('withholds %s instead of inventing or accepting values', async kind => {
    const row: any = { unitId: targetId, ...sourceUse }
    if (kind === 'wrong-id') row.unitId = 'content:1'
    if (kind === 'extra-root') row.extra = 'unreviewed'
    if (kind === 'unknown-source') row.citations = [{ exhibitId: 'E-999', paragraph: 1 }]
    if (kind === 'unknown-record') row.recordCitations = [{ eventId: 'invented' }]
    const { client, bodies } = clientWith(() => kind === 'extra-row' ? { findings: [{ ...row }, { ...row, unitId: 'content:1' }] } : kind === 'empty-findings' ? { findings: [] } : kind === 'unchanged-invalid' ? { unitId: targetId, ...bad } : row)
    expect((await client.reviewGrounding(input, draft)).status).toBe('failed'); expect(bodies).toHaveLength(2)
  })
  it('preserves an independent rejection rather than correcting a verdict into acceptance', async () => {
    const data = initial(); data.findings['content:1'] = { ...assessment, status: 'unsupported', explanation: 'A separate unsupported premise.' }
    let calls = 0
    const client = new MiniMaxClient(config, undefined, async () => { calls++; return response(data) })
    const result = await client.reviewGrounding(input, draft)
    expect(result.status).toBe('failed'); expect(result.findings[0].status).toBe('unsupported'); expect(calls).toBe(1)
  })
  it('still checks factual premises labeled as source-use analysis', () => {
    const unit = { id: 'content:1', text: 'Its confirmation that the signature is authentic establishes authenticity.' }
    expect(parseGroundingReview(JSON.stringify({ findings: { 'content:1': sourceUse } }), [unit], [], coverage).status).toBe('failed')
  })
})

describe('observed procedural acknowledgements without assessment', () => {
  const raw = JSON.stringify({ findings: { 'content:1': assessment } })
  const message = (content: string) => ({ content, tool_calls: [{ type: 'function', function: { name: 'record_grounding_review', arguments: raw } }] })
  it.each(["I'll audit each unit against the permitted sources and record.", "I'll audit each unit against the permitted sources before recording findings.", 'I’ll audit each unit against the permitted sources before recording findings.'])('retains exact arguments after %s', content => {
    expect(groundingToolContent(message(content))).toBe(raw)
  })
  it.each([' All units are supported.', ' E-001 proves the allegation.', ' {"findings":{}}', ' The judge should discharge the restraint.'])('does not permit substantive or competing output %s', extra => {
    expect(() => groundingToolContent(message("I'll audit each unit against the permitted sources and record." + extra))).toThrow('competing message content')
  })
  it('does not repair malformed arguments after a procedural acknowledgement', () => {
    const value = message("I'll audit each unit against the permitted sources before recording findings.")
    value.tool_calls[0].function.arguments = '{"findings":{}}'
    expect(groundingToolContent(value)).toBe('{"findings":{}}')
    expect(parseGroundingReview(groundingToolContent(value)!, [{ id: 'content:1', text: 'I retain doubt.' }], []).status).toBe('failed')
  })
})


describe('raw finding retention and correction inventory', () => {
  const failedReview = () => parseGroundingReview(JSON.stringify(initial()), units, input.evidence, coverage)
  it('scopes only failed known rows from a complete raw keyed inventory', () => {
    expect(groundingCorrectionUnits(units, failedReview(), JSON.stringify(initial())).map(unit => unit.id)).toEqual([targetId])
  })
  it.each(['syntax', 'missing', 'extra-row', 'extra-root', 'array', 'global-error'])('requires a full correction for %s', kind => {
    const data: any = initial(), review = failedReview()
    if (kind === 'missing') delete data.findings['content:1']
    if (kind === 'extra-row') data.findings['invented:1'] = assessment
    if (kind === 'extra-root') data.extra = 'unreviewed'
    if (kind === 'array') data.findings = Object.entries(data.findings).map(([unitId, row]) => ({ unitId, ...row as object }))
    if (kind === 'global-error') review.errors.push('Invalid findings schema')
    expect(groundingCorrectionUnits(units, review, kind === 'syntax' ? '{' : JSON.stringify(data))).toBe(units)
  })
  it('merges only an explicitly returned requested row without mutating previous raw values', () => {
    const before = JSON.stringify(initial()), next = JSON.stringify({ findings: { [targetId]: sourceUse } })
    const merged = JSON.parse(mergeGroundingCorrection(before, next, units, [units.find(unit => unit.id === targetId)!]))
    expect(JSON.parse(before)).toEqual(initial())
    for (const unit of units) expect(merged.findings[unit.id]).toEqual(unit.id === targetId ? sourceUse : assessment)
  })
  it.each([{ findings: {} }, { findings: { 'invented:1': sourceUse } }, { findings: { [targetId]: sourceUse }, extra: true }])('rejects an incomplete or escaped correction %j', value => {
    expect(() => mergeGroundingCorrection(JSON.stringify(initial()), JSON.stringify(value), units, [units.find(unit => unit.id === targetId)!])).toThrow('exactly its requested finding IDs')
  })
  it('uses uniform rows when two failed units need correction', async () => {
    const data = initial(); data.findings['content:1'] = bad
    const bodies: any[] = []
    const client = new MiniMaxClient(config, undefined, async (_url, init) => {
      const body = JSON.parse(String(init?.body)); bodies.push(body)
      if (bodies.length === 1) return response(data)
      expect(body.tools[0].function.parameters.properties.reviewJson.description).toContain(JSON.stringify(['content:1', targetId]))
      const requested = JSON.parse(body.messages[1].content.split('Draft units to check:\n')[1])
      expect(requested.map((unit: any) => unit.id)).toEqual(['content:1', targetId])
      return response({ findings: requested.map((unit: any) => ({ unitId: unit.id, ...(unit.id === targetId ? sourceUse : assessment) })) })
    })
    expect((await client.reviewGrounding(input, draft)).status).toBe('passed'); expect(bodies).toHaveLength(2)
  })
  it('retains the existing full-unit correction contract for compatible providers', async () => {
    let calls = 0
    const client = new MiniMaxClient({ ...config, provider: 'openai-compatible' }, undefined, async (_url, init) => {
      const body = JSON.parse(String(init?.body)); calls++
      const requested = JSON.parse(body.messages[1].content.split('Draft units to check:\n')[1])
      expect(requested).toEqual(units)
      return Response.json({ choices: [{ message: { content: JSON.stringify(calls === 1 ? initial() : { findings: Object.fromEntries(units.map(unit => [unit.id, unit.id === targetId ? sourceUse : assessment])) }) } }] })
    })
    expect((await client.reviewGrounding(input, draft)).status).toBe('passed'); expect(calls).toBe(2)
  })
})


it.each([{ targets: [] }, { targets: [{ id: 'invented:1', text: 'Unknown unit.' }] }])('rejects an empty or non-draft correction scope %j', ({ targets }) => {
  expect(() => mergeGroundingCorrection(JSON.stringify(initial()), JSON.stringify({ findings: Object.fromEntries(targets.map(unit => [unit.id, sourceUse])) }), units, targets)).toThrow('exactly its requested finding IDs')
})
