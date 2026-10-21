import { describe, expect, it } from 'vitest'
import { buildJuryFocusFollowup } from '../scripts/juryFocusFollowup'

function fixture() {
  const controls = Array.from({ length: 72 }, (_, i) => ({ id: `control-${i}`, expected: i % 2 ? 'failed' : 'passed' }))
  const fresh = Array.from({ length: 6 }, (_, i) => ({ id: `fresh-${i}`, request: { fictional: true, input: i < 3 ? 1 : 2 } }))
  const plan = { controls, fresh, nativePlanHash: 'fictional-native', sourceHashes: [], settings: { model: 'MiniMax-M3.1-Flash-Preview', reasoningEffort: 'high' }, limits: { maxCalls: 100, maxInputCharacters: 8000000, maxElapsedMs: 1200000, requestTimeoutMs: 240000 } }
  const results = { results: [...controls.map(c => ({ id: c.id, kind: 'control', state: 'finished', expected: c.expected, expectedMatched: true, review: { status: c.expected } })), { id: fresh[0].id, kind: 'fresh', state: 'failed', error: 'Provider HTTP pilot budget reached' }], unexecuted: fresh.slice(1).map(x => x.id), usage: { providerHttpCalls: 75, providerInputCharacters: 7500 } }
  const receipts: any[] = Array.from({ length: 74 }, (_, i) => ({ caseId: controls[i % 72].id, requestRole: 'checker', state: 'received', httpStatus: 200, requestCharacters: 100 }))
  receipts.push({ caseId: fresh[0].id, requestRole: 'author', state: 'failed', requestCharacters: 100, error: { message: 'Pilot overall deadline reached.' }, partialResponseBytes: 0 })
  return { plan, results, receipts }
}
describe('fresh-only follow-up after a complete control run hits its deadline', () => {
  it('preserves all six inputs and subtracts prior dispatches from aggregate ceilings', () => {
    const f = fixture(), next = buildJuryFocusFollowup(f.plan, f.results, f.receipts)
    expect(next.fresh).toEqual(f.plan.fresh)
    expect(next.fresh).not.toBe(f.plan.fresh)
    expect(next.controls).toEqual([])
    expect(next.limits).toEqual({ maxCalls: 25, maxInputCharacters: 7992500, maxElapsedMs: 1200000, requestTimeoutMs: 240000 })
    expect(next.completedControlIds).toEqual(f.plan.controls.map(x => x.id))
    expect(next.settings).toEqual(f.plan.settings)
    expect(next.runtimeScope).toContain('separate')
  })
  it('rejects a control mismatch even when its success flag is true', () => {
    const f = fixture(); (f.results.results[0] as any).review.status = 'failed'
    expect(() => buildJuryFocusFollowup(f.plan, f.results, f.receipts)).toThrow()
  })
  it('rejects a missing control', () => {
    const f = fixture(); f.results.results.shift()
    expect(() => buildJuryFocusFollowup(f.plan, f.results, f.receipts)).toThrow()
  })
  it('rejects duplicate control identities', () => {
    const f = fixture(); f.results.results[1].id = f.results.results[0].id
    expect(() => buildJuryFocusFollowup(f.plan, f.results, f.receipts)).toThrow()
  })
  it('requires the actual overall-deadline error', () => {
    const f = fixture(); f.receipts[74].error.message = 'Unrelated network failure'
    expect(() => buildJuryFocusFollowup(f.plan, f.results, f.receipts)).toThrow()
  })
  it('rejects a completed author receipt', () => {
    const f = fixture(); Object.assign(f.receipts[74], { state: 'received', httpStatus: 200 })
    expect(() => buildJuryFocusFollowup(f.plan, f.results, f.receipts)).toThrow()
  })
  it('rejects partial author response bytes that require separate substantive review', () => {
    const f = fixture(); f.receipts[74].partialResponseBytes = 10
    expect(() => buildJuryFocusFollowup(f.plan, f.results, f.receipts)).toThrow()
  })
  it('rejects a failed receipt belonging to another case', () => {
    const f = fixture(); f.receipts[74].caseId = 'other'
    expect(() => buildJuryFocusFollowup(f.plan, f.results, f.receipts)).toThrow()
  })
  it('rejects receipt/counter disagreement', () => {
    const f = fixture(); f.receipts.pop()
    expect(() => buildJuryFocusFollowup(f.plan, f.results, f.receipts)).toThrow()
  })
  it('rejects character-counter disagreement', () => {
    const f = fixture(); f.results.usage.providerInputCharacters++
    expect(() => buildJuryFocusFollowup(f.plan, f.results, f.receipts)).toThrow()
  })
  it('requires enough remaining calls for six generation/check pairs', () => {
    const f = fixture(); f.plan.limits.maxCalls = 86
    expect(() => buildJuryFocusFollowup(f.plan, f.results, f.receipts)).toThrow()
  })
  it('rejects already accepted fresh output rather than silently rerunning it', () => {
    const f = fixture(); Object.assign(f.results.results[72], { state: 'finished', generated: { content: 'fictional' } })
    expect(() => buildJuryFocusFollowup(f.plan, f.results, f.receipts)).toThrow()
  })
  it('rejects the older model', () => {
    const f = fixture(); f.plan.settings.model = 'MiniMax-M3'
    expect(() => buildJuryFocusFollowup(f.plan, f.results, f.receipts)).toThrow()
  })
})
