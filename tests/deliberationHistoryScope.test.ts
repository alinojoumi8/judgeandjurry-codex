import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { groundingUnits, ballotConsistencyUnits } from '../server/grounding'
import { MiniMaxClient } from '../server/minimax'

const original = JSON.parse(readFileSync('docs/qa/jury/v185-captured-negation-and-authentication.json', 'utf8')).items[0]
const baseFindings = JSON.parse(original.checkerContent).findings
function draft(metadata: string) {
  const result = structuredClone(original.result)
  result.jurors[0].mindChangedBecause = metadata
  return result
}
function accepted(result: any, eventId?: string) {
  const units = [...groundingUnits(result), ...ballotConsistencyUnits(result)]
  return JSON.stringify({ findings: units.map(unit => {
    const found = structuredClone(baseFindings.find((finding: any) => finding.unitId === unit.id) ?? { unitId: unit.id, status: 'analysis', explanation: 'Present assessment metadata.', citations: [], recordCitations: [] })
    if (unit.id.startsWith('juror-change-')) {
      found.status = 'analysis'; found.citations = []
      found.recordCitations = eventId && /Crown stated/.test(unit.text) ? [{ eventId }] : []
      found.explanation = eventId && /Crown stated/.test(unit.text) ? 'Accurately attributes the actual public Crown statement; it does not establish its truth.' : 'Auditor accepts the metadata as present assessment.'
    }
    return found
  }) })
}
async function check(request: any, result: any, response = accepted(result)) {
  const client = new MiniMaxClient({ provider: 'minimax', apiKey: 'fictional', baseUrl: 'https://fixture.invalid/v1', model: 'fixture', timeoutMs: 2000, maxRetries: 0 }, undefined,
    async () => Response.json({ choices: [{ message: { content: response } }] }))
  return client.reviewGrounding(request, result)
}
function historySource(purpose = 'Report procedural history.', text = 'For this run, no deliberation has occurred.') {
  const request = structuredClone(original.request)
  request.evidence = [{ ...request.evidence[0], text }]
  request.groundingContext = `E-001: admitted; permitted purposes: ${purpose}`
  const result = structuredClone(original.result)
  result.title = ''; result.content = ''; result.citations = ['E-001']
  result.jurors[0].leaning = 'defence'; result.jurors[0].rationale = 'I retain doubt under the supplied burden.'
  result.jurors[0].citations = ['E-001']; result.jurors[0].mindChangedBecause = 'No deliberation has occurred.'
  const units = [...groundingUnits(result), ...ballotConsistencyUnits(result)]
  const response = JSON.stringify({ findings: units.map(unit => ({ unitId: unit.id, status: unit.id.startsWith('juror-change-') ? 'supported' : 'analysis', explanation: 'The actual permitted history passage directly supplies the occurrence-absence statement.', citations: unit.id.startsWith('juror-change-') ? [{ exhibitId: 'E-001', paragraph: 1 }] : [], recordCitations: [] })) })
  return { request, result, response }
}

describe('deliberation history is distinct from visible input inventory', () => {
  it('withholds the actual unqualified original even when every auditor finding accepts it', async () => {
    const review = await check(original.request, original.result, original.checkerContent)
    expect(review.status).toBe('failed')
    expect(review.errors.join(' ')).toContain('deliberation occurrence')
  })
  it('accepts the derived positive with explicit visible-record metadata', async () => {
    expect((await check(original.request, draft('This is my initial ballot, and no visible deliberation event is supplied.'))).status).toBe('passed')
  })
  it('preserves a present own-position statement without asserting occurrence history', async () => {
    expect((await check(original.request, draft('This is my initial ballot, so no prior assessment or deliberation event has changed my position.'))).status).toBe('passed')
  })
  it('withholds a false visible-inventory absence when an actual deliberation event is supplied', async () => {
    const request = structuredClone(original.request)
    request.courtroomEvents.push({ eventId: 'actual-deliberation', type: 'juror_deliberation_turn', actorId: 'juror-02', phase: 'deliberation_inventory', payload: { contribution: 'Consider E-001.' } })
    expect((await check(request, draft('No visible deliberation event is supplied.'))).status).toBe('failed')
  })
  it('preserves an absence expressly confined to the supplied record', async () => {
    expect((await check(original.request, draft('No deliberation has occurred within the supplied record.'))).status).toBe('passed')
  })
  it.each(['No visible deliberation event is supplied.', 'No deliberation has occurred within the supplied record.'])('does not treat an omitted event inventory as an empty one: %s', async metadata => {
    const request = structuredClone(original.request)
    delete request.courtroomEvents
    expect((await check(request, draft(metadata))).status).toBe('failed')
  })
  it('withholds explicitly global occurrence absence', async () => {
    expect((await check(original.request, draft('No deliberation has occurred anywhere in any proceeding ever.'))).status).toBe('failed')
  })
  it('preserves a genuine conditional without adopting its premise', async () => {
    expect((await check(original.request, draft('If no deliberation has occurred, I would need the visible history before making a claim.'))).status).toBe('passed')
  })
  it('preserves a neutral history question', async () => {
    expect((await check(original.request, draft('No deliberation has occurred?'))).status).toBe('passed')
  })
  it('preserves an actual directly supporting passage under procedural-history permission', async () => {
    const { request, result, response } = historySource()
    expect((await check(request, result, response)).status).toBe('passed')
  })
  it('does not turn an attribution-only history passage into occurrence truth', async () => {
    const { request, result, response } = historySource('Attribute the account only; not proof of procedural history.')
    expect((await check(request, result, response)).status).toBe('failed')
  })
  it('preserves accurate quotation of a visible public statement without adopting its truth', async () => {
    const request = structuredClone(original.request)
    request.courtroomEvents.push({ eventId: 'crown-history', type: 'public_submission', actorId: 'crown', phase: 'closings', payload: { text: 'No deliberation has occurred.' } })
    const result = draft('The Crown stated "No deliberation has occurred."')
    expect((await check(request, result, accepted(result, 'crown-history'))).status).toBe('passed')
  })
  it('withholds a separate adopted absence after the same verified public quotation', async () => {
    const request = structuredClone(original.request)
    request.courtroomEvents.push({ eventId: 'crown-history', type: 'public_submission', actorId: 'crown', phase: 'closings', payload: { text: 'No deliberation has occurred.' } })
    const result = draft('The Crown stated "No deliberation has occurred." No deliberation has occurred.')
    expect((await check(request, result, accepted(result, 'crown-history'))).status).toBe('failed')
  })
  it('does not let an adjacent record qualifier hide a separate global assertion', async () => {
    expect((await check(original.request, draft('Within the supplied record, no deliberation has occurred; no deliberation has occurred anywhere.'))).status).toBe('failed')
  })
  it('does not derive occurrence absence from a conditional source passage', async () => {
    const { request, result, response } = historySource('Report procedural history.', 'If no deliberation has occurred, the ledger would be short.')
    expect((await check(request, result, response)).status).toBe('failed')
  })
})
