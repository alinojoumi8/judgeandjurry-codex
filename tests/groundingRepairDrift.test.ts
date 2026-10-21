import { describe, expect, it } from 'vitest'
import { MiniMaxClient, type StageRequest } from '../server/minimax'
import { supportedOpeningSource } from '../samples/courtroom-realism/supported-opening'
import type { GroundingUnit } from '../server/grounding'
import { groundingUnits, type GroundingReview } from '../server/grounding'
import { applyGroundingPatch, groundingPatchInstructions, groundingRepairDrift } from '../server/groundingRepair'
import type { StageResult } from '../server/types'

const request: StageRequest = { stage: 'crown_opening', packet: 'Fictional source exercise.', previousTurns: '', groundingRequired: true,
  evidence: [{ ...supportedOpeningSource, exhibitId: 'E-001', text: 'The report records a blue token at the desk.' }] }
const good = 'E-001 records a blue token at the desk.'
const bad = 'The report independently proves guilt.'
const draft = { title: 'Source review', content: `${good} ${bad}`, citations: ['E-001'], jurors: [] }
function harness(repaired: unknown, toolOutput?: 'valid' | 'wrong-name' | 'duplicate' | 'competing' | 'malformed-json') {
  const prompts: string[] = []
  const bodies: any[] = []
  let authors = 0
  const client = new MiniMaxClient({ provider: toolOutput ? 'minimax' : 'openai-compatible', apiKey: 'fixture', baseUrl: 'http://127.0.0.1:11434/v1', model: 'fixture', timeoutMs: 1000, maxRetries: 1 }, undefined, async (_url, init) => {
    const body = JSON.parse(String(init?.body)); bodies.push(body)
    const prompt = body.messages[1].content as string; prompts.push(prompt)
    const audit = prompt.includes('Draft units to check:\n')
    const result = audit ? { findings: (JSON.parse(prompt.split('Draft units to check:\n')[1]) as GroundingUnit[]).map(u => ({ unitId: u.id,
      status: u.text === bad ? 'unsupported' : u.text.includes('E-001') ? 'supported' : 'analysis', explanation: u.text === bad ? 'The report does not independently establish guilt.' : 'Supported or procedural.',
      citations: u.text.includes('E-001') ? [{ exhibitId: 'E-001', paragraph: 1 }] : [] })) } : ++authors === 1 ? draft : repaired
    if (!audit && authors > 1 && toolOutput) {
      const call = { type: 'function', function: { name: toolOutput === 'wrong-name' ? 'other_tool' : 'repair_grounding_units', arguments: toolOutput === 'malformed-json' ? '{"repairs":[' : JSON.stringify(result) } }
      return Response.json({ choices: [{ finish_reason: 'tool_calls', message: { content: toolOutput === 'competing' ? JSON.stringify(result) : null, tool_calls: toolOutput === 'duplicate' ? [call, call] : [call] } }] })
    }
    return Response.json({ choices: [{ message: { content: JSON.stringify(result) } }] })
  })
  return { client, prompts, bodies }
}
describe('grounding repairs preserve accepted text', () => {
  it('uses one MiniMax repair schema and rechecks its applied text without rewriting accepted units', async () => {
    const { client, prompts, bodies } = harness({ repairs: [{ unitId: 'content:2', replacement: 'The issue remains unresolved.' }] }, 'valid')
    const result = await client.generateStage(request)
    expect(result.content).toBe(`${good} The issue remains unresolved.`)
    expect(result.grounding?.status).toBe('passed')
    expect(bodies[2].tool_choice).toBe('required')
    const tool = bodies[2].tools[0].function
    expect(tool.name).toBe('repair_grounding_units')
    expect(tool.parameters.properties.repairs.items.required).toEqual(['unitId', 'replacement'])
    expect(tool.parameters.properties.repairs.items.properties.unitId.enum).toEqual(['content:2'])
    expect(prompts[2]).toContain(`"sourceText":"${bad}"`)
    expect(prompts[2]).not.toContain('Return this JSON shape:')
    expect(prompts[3]).toContain(good)
    expect(result.grounding?.appliedRepairs?.[0].before).toBe(bad)
  })
  it.each(['wrong-name', 'duplicate', 'competing', 'malformed-json'] as const)('retains the rejected source audit when a repair tool is malformed: %s', async mode => {
    const { client, prompts } = harness({ repairs: [{ unitId: 'content:2', replacement: '' }] }, mode)
    await expect(client.generateStage(request)).rejects.toMatchObject({ grounding: { status: 'failed', priorFailures: expect.any(Array), findings: expect.arrayContaining([expect.objectContaining({ text: bad, status: 'unsupported' })]) } })
    expect(prompts).toHaveLength(3)
  })
  it('applies only the requested rejected-unit replacement and rechecks the complete result', async () => {
    const { client, prompts } = harness({ repairs: [{ unitId: 'content:2', replacement: 'The issue remains unresolved.' }] })
    const result = await client.generateStage(request)
    expect(result.content).toBe(`${good} The issue remains unresolved.`)
    expect(result.title).toBe(draft.title)
    expect(result.grounding?.status).toBe('passed')
    expect(result.grounding?.appliedRepairs).toEqual([{ unitId: 'content:2', before: bad, replacement: 'The issue remains unresolved.' }])
    expect(prompts[2]).toContain('OUTPUT CONTRACT FOR THIS REPAIR')
    expect(prompts[3]).toContain(good)
    expect(prompts[3]).toContain('The issue remains unresolved.')
  })
  it('does not auto-accept a patched premise', async () => {
    const { client } = harness({ repairs: [{ unitId: 'content:2', replacement: bad }] })
    await expect(client.generateStage(request)).rejects.toMatchObject({ grounding: { status: 'failed', appliedRepairs: [{ unitId: 'content:2', before: bad, replacement: bad }] } })
  })
  it.each([
    { repairs: [{ unitId: 'content:1', replacement: 'Altered accepted premise.' }] },
    { repairs: [{ unitId: 'unknown:1', replacement: 'Inserted premise.' }] },
    { repairs: [{ unitId: 'content:2', replacement: '' }, { unitId: 'content:2', replacement: 'Duplicate.' }] },
    { repairs: [{ unitId: 'content:2', replacement: 'Resolved.', extra: 'new claim' }] },
    { repairs: [{ unitId: 'content:2', replacement: null }] },
    { repairs: [{ unitId: 'content:2', text: 'Wrong response field.' }] },
    { repairs: [], content: 'New entire answer.' },
    { repairs: [] },
  ])('withholds an invalid patch without partially applying it', async patch => {
    const { client, prompts } = harness(patch)
    await expect(client.generateStage(request)).rejects.toMatchObject({ grounding: { status: 'failed', priorFailures: expect.any(Array) } })
    expect(prompts).toHaveLength(3)
  })
  it('supplies the actual rejected draft and protected units to the repair', async () => {
    const { client, prompts } = harness({ ...draft, content: good })
    const result = await client.generateStage(request)
    expect(result.grounding?.status).toBe('passed')
    expect(result.grounding?.priorFailures).toHaveLength(1)
    expect(prompts[2]).toContain(JSON.stringify(draft))
    expect(prompts[2]).toContain('Preserve accepted units verbatim')
    expect(result.content).toBe(good)
  })
  it.each([
    { ...draft, content: `The blue token proves the disputed act (E-001). The issue remains unresolved.` },
    { ...draft, title: 'Established guilt', content: `${good} The issue remains unresolved.` },
    { ...draft, content: `The Defence conceded the issue. ${good} The issue remains unresolved.` },
  ])('withholds drift outside rejected text', async repaired => {
    const { client, prompts } = harness(repaired)
    await expect(client.generateStage(request)).rejects.toMatchObject({ grounding: { status: 'failed', errors: expect.arrayContaining([expect.stringContaining('repair drift')]) } })
    expect(prompts).toHaveLength(3)
  })
  it('permits a local correction and checks the complete repaired response', async () => {
    const { client, prompts } = harness({ ...draft, content: `${good} The issue remains unresolved.` })
    expect((await client.generateStage(request)).grounding?.status).toBe('passed')
    expect(prompts).toHaveLength(4)
    expect(prompts[3]).toContain(good)
    expect(prompts[3]).toContain('The issue remains unresolved.')
  })
})

describe('repair span ownership', () => {
  const review = (value: StageResult, rejected: string[]): GroundingReview => ({ status: 'failed', method: 'source-quotes-and-model-review', repairs: 0, errors: [], findings: groundingUnits(value).map(unit => ({ unitId: unit.id, text: unit.text, status: rejected.includes(unit.id) ? 'unsupported' : 'analysis', explanation: 'Fixture judgment.', citations: [] })) })
  it('patches the rejected repeated occurrence and leaves the original object intact', () => {
    const before = { ...draft, content: `${good} ${good}` }
    const after = applyGroundingPatch(before, review(before, ['content:2']), { repairs: [{ unitId: 'content:2', replacement: '' }] }).result
    expect(after.content).toBe(good)
    expect(before.content).toBe(`${good} ${good}`)
  })
  it('patches nested change reasons while preserving accepted rationale and choice', () => {
    const before: StageResult = { ...draft, jurors: [{ juror: 'juror-01', leaning: 'defence', confidence: 60, rationale: 'I retain doubt.', citations: [], mindChangedBecause: 'A new invented peer persuaded me.' }] }
    const audit = review(before, ['juror-change-0:1'])
    const after = applyGroundingPatch(before, audit, { repairs: [{ unitId: 'juror-change-0:1', replacement: 'This is my initial assessment.' }] }).result
    expect(after.jurors![0]).toEqual({ ...before.jurors![0], mindChangedBecause: 'This is my initial assessment.' })
    expect(groundingRepairDrift(before, after, audit)).toEqual([])
    expect(groundingRepairDrift(before, { ...after, jurors: [{ ...after.jurors![0], leaning: 'crown' }] }, audit)).toContain('juror-0: repair drift changed accepted ballot metadata.')
  })
  it('exposes only the fields covered by a failed joint consistency unit', () => {
    const before: StageResult = { ...draft, jurors: [{ juror: 'juror-01', leaning: 'defence', confidence: 60, rationale: 'My assessment.', citations: [], mindChangedBecause: 'My current reason.', consistencyWarnings: ['Independent accepted warning.'] }] }
    const audit = review(before, [])
    audit.findings.push({ unitId: 'ballot-consistency-0:1', text: 'Joint assessment', status: 'contradicted', explanation: 'Inconsistent.', citations: [] })
    const prompt = groundingPatchInstructions(before, audit)
    expect(prompt).toContain('juror-change-0:1')
    expect(prompt).not.toContain('juror-warning-0-0:1')
  })
  it('does not confuse a rejected repeat with the accepted first occurrence', () => {
    const before = { ...draft, content: `${good} ${good}` }
    const audit = review(before, ['content:2'])
    expect(groundingRepairDrift(before, { ...before, content: `The issue is proved. ${good}` }, audit)).not.toEqual([])
    expect(groundingRepairDrift(before, { ...before, content: `${good} The issue remains unresolved.` }, audit)).toEqual([])
  })
  it('allows removal of separated rejected sentences while preserving their accepted neighbor', () => {
    const before = { ...draft, content: `${bad} ${good} A new unsupported claim.` }
    expect(groundingRepairDrift(before, { ...before, content: good }, review(before, ['content:1', 'content:3']))).toEqual([])
  })
  it('protects nested explanations and refuses a new juror field', () => {
    const before: StageResult = { ...draft, jurors: [{ juror: 'juror-01', leaning: 'defence', confidence: 60, rationale: 'I retain doubt.', citations: [], consistencyWarnings: ['The record is limited.'] }] }
    const after = structuredClone(before)
    after.content = good
    after.jurors![0].consistencyWarnings = ['The account proves guilt.']
    after.jurors![0].mindChangedBecause = 'The Defence conceded guilt.'
    expect(groundingRepairDrift(before, after, review(before, ['content:2']))).toEqual(expect.arrayContaining([expect.stringContaining('juror-warning-0-0'), expect.stringContaining('juror-change-0')]))
  })
})
