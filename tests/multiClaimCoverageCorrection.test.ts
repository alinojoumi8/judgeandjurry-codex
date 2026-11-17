import { describe, expect, it } from 'vitest'
import { groundingUnits, parseGroundingReview, type GroundingUnit } from '../server/grounding'
import { MiniMaxClient, type StageRequest } from '../server/minimax'
import { supportedOpeningSource } from '../samples/courtroom-realism/supported-opening'

const claims = [
  'Mira’s account describes Arin carrying a blue token (E-101).',
  'Tavi’s account describes Ellis carrying a green envelope (E-102).',
  'Nia’s account describes Morgan carrying a red folder (E-103).',
]
const words = ['Mira said Arin carried a blue token.', 'Tavi said Ellis carried a green envelope.', 'Nia said Morgan carried a red folder.']
const evidence = words.map((text, index) => {
  const old = `OMITTED_${index}: ${text}`, current = `CURRENT_${index}: ${text}`
  return { ...supportedOpeningSource, id: `source-${index}`, exhibitId: `E-${101 + index}`, name: `FULL_SOURCE_NAME_${index}`,
    text: `${old}\n\n${current}`, authorizedPassages: [
      { paragraph: 1, text: old, startOffset: 0, endOffset: old.length },
      { paragraph: 2, text: current, startOffset: old.length + 2, endOffset: old.length + 2 + current.length },
    ] }
})
const analysis = { status: 'analysis', supportTypes: ['analysis'], explanation: 'A neutral heading or current assessment.', citations: [], recordCitations: [] }
const sourceRow = (index: number, paragraph: number) => ({ ...analysis, status: 'supported', supportTypes: ['source'], explanation: 'The selected account supplies this complete attributed claim.', citations: [{ exhibitId: evidence[index].exhibitId, paragraph }] })
const rows = (units: GroundingUnit[], paragraph = 2, negativeSibling = false) => ({ findings: Object.fromEntries(units.map(unit => {
  const index = claims.indexOf(unit.text)
  return [unit.id, index >= 0 ? sourceRow(index, paragraph) : { ...analysis, ...(negativeSibling && unit.text.includes('$9,200') ? { status: 'unsupported', explanation: 'No source supplies that payment.' } : {}) }]
})) })
type Body = { messages: Array<{ content: string }> }
const inventory = (body: Body): GroundingUnit[] => JSON.parse(body.messages[1].content.split('Draft units to check:\n')[1])

function harness(options: { count?: number; maxRetries?: number; second?: (units: GroundingUnit[]) => unknown; negativeSibling?: boolean; cap?: string } = {}) {
  const count = options.count ?? 2
  const draft = { title: 'Fictional coverage review', content: claims.slice(0, count).join(' ') + (options.negativeSibling ? ' Arin received $9,200.' : ''), citations: evidence.slice(0, count).map(e => e.exhibitId), jurors: [] }
  const request: StageRequest = { stage: 'crown_closing', packet: 'Private author preparation must not enter a focused checker.', previousTurns: '', evidence: evidence.slice(0, count) }
  const units = groundingUnits(draft)
  const previous = parseGroundingReview(JSON.stringify(rows(units, 1, options.negativeSibling)), units, request.evidence)
  expect(previous.findings.filter(f => f.status === 'supported')).toHaveLength(count)
  const bodies: Body[] = []
  let outbound = 0
  const client = new MiniMaxClient({ provider: 'minimax', apiKey: 'fixture', baseUrl: 'https://fixture.invalid/v1', model: 'fixture', timeoutMs: 1000, maxRetries: options.maxRetries ?? 1 }, undefined, async (_url, init) => {
    const body = JSON.parse(String(init?.body)); bodies.push(body)
    if (options.cap && bodies.length > 2) throw new Error(options.cap)
    outbound++
    if (outbound > count + 1) throw new Error('Unexpected extra fixture request.')
    const checked = inventory(body)
    const reply = bodies.length === 3 && options.second ? options.second(checked) : rows(checked, 2, options.negativeSibling)
    return Response.json({ choices: [{ message: { content: JSON.stringify(reply) } }] })
  })
  return { bodies, previous, run: () => client.reviewGrounding(request, draft, previous), outbound: () => outbound }
}

function assertIsolated(body: Body, index: number) {
  expect(inventory(body)).toEqual([{ id: `content:${index + 1}`, text: claims[index] }])
  const text = JSON.stringify(body)
  const record = body.messages[1].content.split('Permitted source record:\n')[1].split('\n\nResponse contract:')[0]
  expect([...record.matchAll(/\[(E-\d+) paragraph (\d+)\]/g)].map(m => [m[1], Number(m[2])])).toEqual([[evidence[index].exhibitId, 2]])
  expect(text).not.toContain('OMITTED_')
  expect(text).not.toContain('FULL_SOURCE_NAME_')
  expect(text).not.toContain('Private author preparation')
  for (let other = 0; other < words.length; other++) if (other !== index) {
    expect(text).not.toContain(`CURRENT_${other}`)
    expect(text).not.toContain(claims[other])
  }
}

describe('multi-claim coverage correction retains independent source projections', () => {
  it.each([1, 2])('reviews both losses in one round with configured maxRetries=%i', async maxRetries => {
    const h = harness({ maxRetries })
    const review = await h.run()
    expect(h.bodies).toHaveLength(3)
    assertIsolated(h.bodies[1], 0); assertIsolated(h.bodies[2], 1)
    expect(review.status).toBe('passed')
    expect(review.verificationRetries).toBe(1)
    expect(review.sourceCoverageAnchors?.map(a => a.selectors.map(s => s.paragraph))).toEqual([[2], [2]])
  })

  it('does not special-case a pair or revisit a completed claim when three selections change', async () => {
    const h = harness({ count: 3 })
    const review = await h.run()
    expect(h.bodies).toHaveLength(4)
    for (let index = 0; index < 3; index++) assertIsolated(h.bodies[index + 1], index)
    expect(review.status).toBe('passed')
    expect(review.verificationRetries).toBe(1)
  })

  it('retains an independent substantive rejection while completing both citation checks', async () => {
    const h = harness({ negativeSibling: true })
    const review = await h.run()
    expect(h.bodies).toHaveLength(3)
    expect(review.status).toBe('failed')
    expect(review.errors).toEqual(['content:3: unsupported — No source supplies that payment.'])
    expect(review.findings.find(f => f.unitId === 'content:3')?.status).toBe('unsupported')
    expect(review.sourceCoverageAnchors?.map(a => a.selectors.map(s => s.paragraph))).toEqual([[2], [2]])
  })

  it('makes no correction calls when the caller disables corrections', async () => {
    const h = harness({ maxRetries: 0 })
    const review = await h.run()
    expect(h.bodies).toHaveLength(1)
    expect(review.status).toBe('failed')
    expect(review.errors.filter(e => e.includes('source-selection coverage'))).toHaveLength(2)
  })

  it('reviews an empty current selection without borrowing another claim’s source', async () => {
    const draft = { title: 'Review', content: `${claims[0]} I assess the supplied explanation.`, citations: ['E-101'], jurors: [] }
    const units = groundingUnits(draft)
    const rowsFor = (checked: GroundingUnit[], old = false) => ({ findings: Object.fromEntries(checked.map(unit => [unit.id,
      unit.id === 'content:1' ? sourceRow(0, old ? 1 : 2) : unit.id === 'content:2' && old ? { ...sourceRow(1, 1), status: 'analysis', supportTypes: ['source', 'analysis'] } : analysis])) })
    const previous = parseGroundingReview(JSON.stringify(rowsFor(units, true)), units, evidence)
    expect(previous.status).toBe('passed')
    const bodies: Body[] = []
    const client = new MiniMaxClient({ provider: 'minimax', apiKey: 'fixture', baseUrl: 'https://fixture.invalid/v1', model: 'fixture', timeoutMs: 1000, maxRetries: 1 }, undefined, async (_url, init) => {
      const body = JSON.parse(String(init?.body)); bodies.push(body)
      return Response.json({ choices: [{ message: { content: JSON.stringify(rowsFor(inventory(body))) } }] })
    })
    const review = await client.reviewGrounding({ stage: 'crown_closing', packet: '', previousTurns: '', evidence }, draft, previous)
    expect(bodies).toHaveLength(3)
    expect(inventory(bodies[2])).toEqual([units[2]])
    expect(JSON.stringify(bodies[2])).not.toMatch(/CURRENT_|OMITTED_|FULL_SOURCE_NAME_/)
    expect(review.status).toBe('passed')
    expect(review.sourceCoverageAnchors?.map(anchor => anchor.unitId)).toEqual(['content:1'])
  })

  it.each(['missing-field', 'empty-review', 'other-unit', 'other-source', 'omitted-paragraph', 'unknown-source', 'record-reference', 'missing-premise'] as const)('withholds an unresolved second check: %s', async mode => {
    const h = harness({ second: units => {
      const row: Record<string, unknown> = sourceRow(1, 2)
      if (mode === 'missing-field') delete row.recordCitations
      if (mode === 'empty-review') return {}
      if (mode === 'other-source') row.citations = [{ exhibitId: 'E-101', paragraph: 2 }]
      if (mode === 'omitted-paragraph') row.citations = [{ exhibitId: 'E-102', paragraph: 1 }]
      if (mode === 'unknown-source') row.citations = [{ exhibitId: 'E-999', paragraph: 2 }]
      if (mode === 'record-reference') row.recordCitations = [{ eventId: 'outside-focused-record' }]
      if (mode === 'missing-premise') { row.status = 'unsupported'; row.explanation = 'The selected account does not supply the complete claim.' }
      return { findings: { [mode === 'other-unit' ? 'content:1' : units[0].id]: row } }
    } })
    const review = await h.run()
    expect(h.bodies).toHaveLength(3)
    expect(review.status).toBe('failed')
    expect(review.errors.length).toBeGreaterThan(0)
    if (mode === 'missing-premise') expect(review.findings.find(f => f.unitId === 'content:2')?.status).toBe('unsupported')
  })

  it.each(['Bounded request cap reached', 'Bounded elapsed-time cap reached'])('preserves progress and pending failure when the transport reports %s', async cap => {
    const h = harness({ cap })
    await expect(h.run()).rejects.toMatchObject({ grounding: {
      status: 'failed', verificationRetries: 1,
      errors: expect.arrayContaining([expect.stringContaining('content:2: checker source-selection coverage'), expect.stringContaining(cap)]),
      sourceCoverageAnchors: expect.arrayContaining([expect.objectContaining({ unitId: 'content:1', selectors: [expect.objectContaining({ paragraph: 2 })] })]),
    } })
    expect(h.outbound()).toBe(2)
    expect(h.bodies).toHaveLength(3)
  })
})
