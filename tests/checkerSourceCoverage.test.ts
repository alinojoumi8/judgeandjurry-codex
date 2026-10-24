import { describe, expect, it } from 'vitest'
import { CheckerSourceCoverageTracker, selectedSourceCoverageEvidence, type CheckerSourceCoverageAnchor } from '../server/checkerSourceCoverage'
import { sourceParagraphs, type GroundingFinding, type GroundingReview, type GroundingUnit } from '../server/grounding'
import type { EvidenceItem } from '../server/types'

const unit: GroundingUnit = { id: 'content:2', text: 'Rowan recorded a deposit and Morgan disputed the signature.' }
const first = { paragraph: 3, text: 'Rowan recorded a fictional deposit in the ledger.', startOffset: 150, endOffset: 198 }
const unique = { paragraph: 9, text: 'Morgan disputed the signature on the fictional receipt.', startOffset: 600, endOffset: 654 }
const alternative = { paragraph: 21, text: 'The fictional joint note records the deposit and Morgan’s disputed signature.', startOffset: 1300, endOffset: 1374 }
const source: EvidenceItem = { id: 'source-a', matterId: 'fictional', exhibitId: 'E-001', name: 'PRIVATE_FILENAME', type: 'pdf', mimeType: 'application/pdf', size: 3000,
  text: 'PRIVATE_FULL_TEXT not included in the authorized passages.', summary: 'PRIVATE_SUMMARY', tags: ['PRIVATE_TAG'], extractionWarning: 'PRIVATE_WARNING',
  uploadedAt: '2026-01-01', sha256: 'fictional-hash', sourceAvailable: true, ingestionStatus: 'stored', archivedAt: null, sourcePages: [2, 7, 15], authorizedPassages: [first, unique, alternative] }
const second: EvidenceItem = { ...source, id: 'source-b', exhibitId: 'E-002' }
function finding(paragraphs = [3, 9], changes: Partial<GroundingFinding> = {}): GroundingFinding {
  return { unitId: unit.id, text: unit.text, status: 'supported', supportTypes: ['source'], explanation: 'Fictional source-selection review.',
    citations: paragraphs.map(paragraph => { const part = source.authorizedPassages!.find(value => value.paragraph === paragraph)!; return { exhibitId: source.exhibitId, quote: part.text, paragraph, startOffset: part.startOffset, endOffset: part.endOffset } }), ...changes }
}
function review(value = finding(), changes: Partial<GroundingReview> = {}): GroundingReview {
  return { status: 'passed', method: 'source-quotes-and-model-review', repairs: 0, findings: [value], errors: [], ...changes }
}
function tracked() { const tracker = new CheckerSourceCoverageTracker(); tracker.record([unit], review(), [source]); return tracker }

describe('checker source coverage anchors', () => {
  it('detects an omitted unique-clause selector without copying it into the new finding', () => {
    const tracker = tracked(), current = finding([3]), before = structuredClone(current)
    const losses = tracker.losses([unit], review(current), [source])
    expect(losses).toEqual([{ unitId: unit.id, text: unit.text,
      previousSelectors: [{ evidenceId: source.id, exhibitId: 'E-001', paragraph: 3 }, { evidenceId: source.id, exhibitId: 'E-001', paragraph: 9 }],
      currentSelectors: [{ evidenceId: source.id, exhibitId: 'E-001', paragraph: 3 }], removedSelectors: [{ evidenceId: source.id, exhibitId: 'E-001', paragraph: 9 }] }])
    expect(current).toEqual(before)
    tracker.record([unit], review(current), [source])
    expect(tracker.losses([unit], review(current), [source])).toHaveLength(1)
  })

  it('retains valid historical anchors despite sibling failures and a later negative', () => {
    const tracker = new CheckerSourceCoverageTracker(), negative = finding([], { status: 'unsupported' })
    const prior = review(negative, { status: 'failed', errors: ['content:2: insufficient supporting account.'], verificationFailures: [
      { attempt: 1, findings: [finding()], errors: ['content:1: malformed heading metadata.'] },
      { attempt: 2, findings: [negative], errors: ['content:2: insufficient supporting account.'] },
    ] })
    tracker.record([unit], prior, [source])
    expect(tracker.losses([unit], review(finding([3])), [source])).toHaveLength(1)
    expect(tracker.losses([unit], prior, [source])).toEqual([])
  })

  it('also records the current prior review positive when only a sibling has errors', () => {
    const tracker = new CheckerSourceCoverageTracker()
    tracker.record([unit], review(finding(), { status: 'failed', errors: ['content:1: missing record metadata.'] }), [source])
    expect(tracker.losses([unit], review(finding([3])), [source])).toHaveLength(1)
  })

  it.each([
    review(finding(), { errors: ['content:2: unavailable source paragraph.'] }),
    review(finding(), { validationErrors: ['content:2: invalid selector field.'] }),
    review(finding(), { sourceLocatorValidationUnitIds: [unit.id] }),
    review(finding(), { explicitRejections: [{ unitId: unit.id, text: unit.text, status: 'unsupported', explanation: 'Rejected.' }] }),
    review(finding(), { findings: [finding(), finding()] }),
    review(finding([3], { citations: [{ ...finding([3]).citations[0], paragraph: 500 }] })),
    review(finding([3], { citations: [{ ...finding([3]).citations[0], quote: 'Invented source words are not in that paragraph.' }] })),
  ])('does not seed an individually invalid finding %#', invalid => {
    const tracker = new CheckerSourceCoverageTracker(); tracker.record([unit], invalid, [source])
    expect(tracker.losses([unit], review(finding([])), [source])).toEqual([])
  })

  it('ignores selector order/duplicates and additions while detecting replacement', () => {
    const tracker = tracked()
    expect(tracker.losses([unit], review(finding([9, 3, 9])), [source])).toEqual([])
    expect(tracker.losses([unit], review(finding([3, 9, 21])), [source])).toEqual([])
    expect(tracker.losses([unit], review(finding([21])), [source])[0].removedSelectors.map(value => value.paragraph)).toEqual([3, 9])
  })

  it('requires independent acceptance of alternatives and permits correcting an earlier false acceptance', () => {
    const tracker = tracked(), current = finding([21])
    tracker.record([unit], review(current), [source])
    expect(tracker.losses([unit], review(current), [source])).toHaveLength(1)
    tracker.acceptCovered(unit, current, [source])
    expect(tracker.losses([unit], review(current), [source])).toEqual([])
    expect(current.citations.map(citation => citation.paragraph)).toEqual([21])
  })

  it('detects source-to-analysis selection loss without making the old judgment authoritative', () => {
    const tracker = tracked(), current = finding([], { status: 'analysis', supportTypes: ['analysis'] })
    expect(tracker.losses([unit], review(current), [source])).toHaveLength(1)
    tracker.acceptCovered(unit, current, [source])
    expect(tracker.losses([unit], review(current), [source])).toEqual([])
  })

  it('binds exact unit IDs/text and ignores changed or excluded permission projections', () => {
    const tracker = tracked(), narrowed = finding([3])
    const changedUnit = { ...unit, text: 'The author now makes a different fictional claim.' }
    expect(tracker.losses([changedUnit], review({ ...narrowed, text: changedUnit.text }), [source])).toEqual([])
    const otherUnit = { ...unit, id: 'content:3' }
    expect(tracker.losses([otherUnit], review({ ...narrowed, unitId: otherUnit.id }), [source])).toEqual([])
    expect(tracker.losses([unit], review(narrowed), [])).toEqual([])
    expect(tracker.losses([unit], review(narrowed), [{ ...source, authorizedPassages: [first] }])).toEqual([])
    expect(tracker.losses([unit], review(narrowed), [{ ...source, authorizedPassages: [first, unique, { ...alternative, text: 'The currently permitted source text changed.' }] }])).toEqual([])
    expect(tracker.losses([unit], review(narrowed), [source], 'new notice-only purpose')).toEqual([])
  })

  it('detects cross-document replacement when the former source remains permitted', () => {
    const tracker = tracked(), current = finding([3], { citations: finding([3]).citations.map(citation => ({ ...citation, exhibitId: second.exhibitId })) })
    expect(tracker.losses([unit], review(current), [source, second])).toHaveLength(1)
    expect(tracker.losses([unit], review(current), [second])).toEqual([])
  })

  it('preserves pending loss through a serialized malformed focused review and unchanged author repair', () => {
    const original = tracked(), current = finding([3])
    const malformed = review(current, { status: 'failed', findings: [], errors: ['Invalid findings schema.'], sourceCoverageAnchors: original.snapshot() })
    const restored = new CheckerSourceCoverageTracker(JSON.parse(JSON.stringify(malformed.sourceCoverageAnchors)))
    restored.record([unit], malformed, [source])
    expect(restored.losses([unit], review(current), [source])).toHaveLength(1)
    restored.record([unit], review(current), [source])
    expect(new CheckerSourceCoverageTracker(restored.snapshot()).losses([unit], review(current), [source])).toHaveLength(1)
  })

  it('retains original permission/source fingerprints after serialization rather than rebinding old history', () => {
    const original = new CheckerSourceCoverageTracker(); original.record([unit], review(), [source], 'truth for approved issue')
    const snapshot = JSON.parse(JSON.stringify(original.snapshot()))
    const restored = new CheckerSourceCoverageTracker(snapshot)
    expect(restored.losses([unit], review(finding([3])), [source], 'truth for approved issue')).toHaveLength(1)
    expect(restored.losses([unit], review(finding([3])), [source], 'notice only')).toEqual([])
    expect(restored.losses([unit], review(finding([3])), [{ ...source, authorizedPassages: [first] }], 'truth for approved issue')).toEqual([])
    expect(restored.snapshot()).toEqual(snapshot)
    expect(JSON.stringify(snapshot)).not.toContain(first.text)
    snapshot[0].selectors[0].paragraph = 999
    expect(restored.snapshot()[0].selectors[0].paragraph).toBe(3)
  })

  it('ignores malformed serialized anchors without widening context', () => {
    const valid = tracked().snapshot()[0]
    const invalid = [null, {}, { ...valid, text: 1 }, { ...valid, selectors: [{ evidenceId: source.id, exhibitId: 'E-001', paragraph: -1 }] }, { ...valid, sources: [[source.id, 'not-a-fingerprint']] }, { ...valid, sources: [['unrelated-source', valid.sources[0][1]]] }] as unknown as CheckerSourceCoverageAnchor[]
    const restored = new CheckerSourceCoverageTracker(invalid)
    expect(restored.snapshot()).toEqual([])
    expect(restored.losses([unit], review(finding([3])), [source])).toEqual([])
  })
})

describe('selected-only checker source projection', () => {
  it('preserves original paragraph IDs and offsets while excluding unselected bodies and derived content', () => {
    const input = { ...source, futureSourceBody: 'PRIVATE_FUTURE_BODY' }, original = structuredClone(input)
    const selected = selectedSourceCoverageEvidence([input, second], finding([9, 3, 9]))
    expect(selected).toHaveLength(1)
    expect(sourceParagraphs(selected[0])).toEqual([first, unique])
    expect(selected[0]).toMatchObject({ name: 'E-001', text: `${first.text}\n\n${unique.text}`, summary: '', tags: [], extractionWarning: null, sourcePages: [2, 7, 15] })
    expect(JSON.stringify(selected)).not.toContain('PRIVATE_')
    expect(selected[0].text).not.toContain(alternative.text)
    expect(selected[0]).not.toHaveProperty('futureSourceBody')
    expect(input).toEqual(original)
    selected[0].authorizedPassages![0].text = 'Mutated only in isolated review context.'
    expect(input.authorizedPassages![0].text).toBe(first.text)
  })

  it('fails closed for unavailable, ambiguous or empty selectors', () => {
    expect(selectedSourceCoverageEvidence([source], finding([]))).toEqual([])
    expect(selectedSourceCoverageEvidence([], finding())).toEqual([])
    expect(selectedSourceCoverageEvidence([source, { ...source, id: 'ambiguous' }], finding())).toEqual([])
    expect(selectedSourceCoverageEvidence([source, { ...second, id: source.id }], finding())).toEqual([])
    expect(selectedSourceCoverageEvidence([{ ...source, authorizedPassages: [] }], finding())).toEqual([])
  })
})
