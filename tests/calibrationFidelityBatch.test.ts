import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ballotConsistencyUnits, groundingUnits, parseGroundingReview } from '../server/grounding'
import { MiniMaxClient } from '../server/minimax'
import { resegmentMetadataControl } from './resegmentMetadataControl'

const captures = JSON.parse(readFileSync('docs/qa/jury/v213-captured-calibration-diagnostics.json', 'utf8')).items
const captured = (id: string) => {
  const item = structuredClone(captures.find((item: any) => item.id === id))
  if (id === 'false-default-classification-knowledge') item.checkerResponses.forEach((response: { content: string }) => response.content = resegmentMetadataControl(response.content))
  return item
}

// Injected classifications exercise deterministic application validation;
// they are neither new provider results nor reused live grades.
function review(item: any, whole = false, draft = item.result, request = item.request, reviewOverride?: string) {
  const units = whole ? ballotConsistencyUnits(draft) : groundingUnits(draft)
  return parseGroundingReview(reviewOverride ?? JSON.stringify({ findings: units.map(unit => ({
    unitId: unit.id, status: 'analysis', explanation: 'Offline injected label for source and scope regression.', citations: [], recordCitations: [],
  })) }), units, request.evidence, request.groundingContext,
  { actorId: request.courtroomActor?.id, assessments: request.courtroomAssessments ?? [], profile: request.jurorProfiles?.find((p: any) => p.juror === request.courtroomActor?.id) },
  { packet: request.packet, events: request.courtroomEvents ?? [], actorRoles: request.courtroomActor?.roles ?? [], partyRoles: request.approvedPartyRoles ?? [], actor: request.courtroomActor, stage: request.stage, ballotRound: request.ballotRound })
}

function client(outputs: string[], maxRetries = 2) {
  const sent: any[] = []
  const model = new MiniMaxClient({ provider: 'minimax', apiKey: 'fictional', baseUrl: 'https://fixture.invalid/v1', model: 'fixture', timeoutMs: 2000, maxRetries }, undefined,
    async (_url, init) => {
      sent.push(JSON.parse(String(init?.body)))
      return Response.json({ choices: [{ message: { content: outputs[Math.min(sent.length - 1, outputs.length - 1)] } }] })
    })
  return { model, sent }
}

function correctedReview(item: any) {
  const result = JSON.parse(item.checkerResponses[0].content)
  for (const finding of result.findings) {
    if (item.id === 'false-visible-initial-scope' && finding.unitId.startsWith('juror-change-')) Object.assign(finding, {
      status: 'analysis', explanation: 'The initial task and supplied empty visible event inventory support this record-scoped present assessment.',
    })
    if (['unsupported', 'contradicted'].includes(finding.status)) Object.assign(finding, {
      status: 'analysis', explanation: 'The actual supplied setup supports this record-scoped epistemic or procedural statement; no global occurrence or missing serialized-field claim is made.',
    })
  }
  return JSON.stringify(result)
}

describe('consolidated V212 calibration fidelity diagnostics', () => {
  it.each(['accepted-proof-doubt', 'accepted-metadata-proof-co-basis', 'accepted-unqualified-source-only'])('withholds the actual %s in individual fields', id => {
    expect(review(captured(id)).status).toBe('failed')
  })
  it.each(['accepted-proof-doubt', 'accepted-metadata-proof-co-basis', 'accepted-unqualified-source-only'])('withholds the actual %s in the whole current ballot', id => {
    expect(review(captured(id), true).status).toBe('failed')
  })

  it('allows an explicit independent proof finding with ordinary residual doubt', () => {
    const item = captured('false-negated-account-comparison')
    item.result.jurors[0].rationale = item.result.jurors[0].rationale.replace('does not expressly negate', 'does not deny')
    expect(review(item).status).toBe('passed')
    expect(review(item, true).status).toBe('passed')
  })
  it('does not require a magic proof phrase when independent complete-account credit contains no retained doubt', () => {
    const item = captured('accepted-proof-doubt')
    item.result.content = 'I vote guilty because I independently credit Mira’s complete account of the required handover (E-001).'
    item.result.jurors[0].rationale = 'I credit the complete, specific Mira account of Morgan handing a blue token to Ellis at the desk (E-001), after considering the separate Tavi account (E-002).'
    item.result.jurors[0].mindChangedBecause = 'This is my current initial assessment of the supplied accounts.'
    expect(review(item, true).status).toBe('passed')
  })
  it('preserves a separate negative comparison without making it a causal proof co-basis', () => {
    const item = captured('accepted-metadata-proof-co-basis')
    item.result.jurors[0].mindChangedBecause = 'My position is stable because I credit E-001’s complete receipt account; Tavi’s non-observation is not a denial.'
    expect(review(item).status).toBe('passed')
    expect(review(item, true).status).toBe('passed')
  })
  it('preserves the retained native source comparison without an own proof-credit predicate in metadata', () => {
    const row = JSON.parse(readFileSync('docs/qa/jury/v166-captured-no-supplied-timing-cause.json', 'utf8'))
    expect(review(row, true).status).toBe('passed')
  })
  it('permits an explicitly observation-scoped only clause', () => {
    const item = captured('accepted-unqualified-source-only')
    item.result.jurors[0].rationale = item.result.jurors[0].rationale.replace('and records only', 'and, concerning observation of a handover, records only')
    expect(review(item).status).toBe('passed')
    expect(review(item, true).status).toBe('passed')
  })

  it('does not invert does not expressly negate in an otherwise coherent proof assessment', () => {
    const item = captured('false-negated-account-comparison')
    expect(review(item).status).toBe('passed')
    expect(review(item, true).status).toBe('passed')
  })
  it('recognizes the actual Crown negative proof-method comparison', () => {
    const item = captured('masked-negative-proof-method')
    item.result = { title: '', content: 'The Crown correctly treats Tavi’s non-observation as not proving no handover.', citations: ['E-002'], jurors: [] }
    expect(review(item).status).toBe('passed')
  })
  it('keeps the genuine conflict failure when its neighboring negative comparison is corrected', () => {
    const item = captured('masked-negative-proof-method')
    const actualReview = JSON.parse(item.checkerResponses[0].content)
    Object.assign(actualReview.findings.find((finding: any) => finding.unitId === 'content:4'), { status: 'analysis', explanation: 'Accurate negative proof-method comparison; not an assertion of no handover.' })
    const result = review(item, false, item.result, item.request, JSON.stringify(actualReview))
    expect(result.status).toBe('failed')
    expect(result.findings.some(finding => finding.unitId === 'content:1' && finding.status === 'unsupported')).toBe(true)
    expect(result.errors.some(error => /content:4:/.test(error))).toBe(false)
  })
  it('retains source-actor clarification after fixing an unrelated comparison', () => {
    const item = captured('masked-departure-source-actor')
    item.result.content = item.result.content.replace('Defence agrees that Tavi’s statement that they did not see a handover cannot, by itself, establish that no handover occurred.', 'Defence asks the jury to apply the supplied burden.')
    const result = review(item)
    expect(result.status).toBe('failed')
    expect(result.errors.join(' ')).toMatch(/(?:depart|leav).*(?:speaker|Tavi|actor)|(?:speaker|Tavi|actor).*(?:depart|leav)/i)
  })
  it('allows the named giver and a bounded non-occurrence comparison together', () => {
    const item = captured('masked-departure-source-actor')
    item.result.content = item.result.content.replace('Tavi’s described departure with the token', 'Rowan’s departure with the token, as narrated by Tavi,')
    // The correctly attributed statement still needs its own source locator;
    // an analysis label alone cannot establish this embedded factual premise.
    const findings = groundingUnits(item.result).map(unit => ({ unitId: unit.id, status: 'analysis', explanation: 'Bounded source comparison.', citations: unit.text.includes('Tavi’s statement that') ? [{ exhibitId: 'E-002', paragraph: 1 }] : [], recordCitations: [] }))
    expect(review(item, false, item.result, item.request, JSON.stringify({ findings })).status).toBe('passed')
  })

  it.each(['false-visible-initial-scope', 'false-default-classification-knowledge'])('requires a successful new review for %s', async id => {
    const item = captured(id)
    const invalidReview = item.checkerResponses[id === 'false-visible-initial-scope' ? 1 : 0].content
    const { model, sent } = client([invalidReview, correctedReview(item)])
    const result = await model.reviewGrounding(item.request, item.result)
    expect(result.status).toBe('passed')
    expect(sent).toHaveLength(2)
    expect(result.verificationRetries).toBe(1)
  })
  it.each(['false-visible-initial-scope', 'false-default-classification-knowledge'])('accepts a valid first review of %s without extra calls', async id => {
    const item = captured(id)
    const { model, sent } = client([correctedReview(item)])
    expect((await model.reviewGrounding(item.request, item.result)).status).toBe('passed')
    expect(sent).toHaveLength(1)
  })
  it.each(['false-visible-initial-scope', 'false-default-classification-knowledge'])('withholds unchanged invalid %s reviews at the existing limit', async id => {
    const item = captured(id)
    const { model, sent } = client([item.checkerResponses[id === 'false-visible-initial-scope' ? 1 : 0].content])
    expect((await model.reviewGrounding(item.request, item.result)).status).toBe('failed')
    expect(sent).toHaveLength(3)
  })
  it.each(['false-visible-initial-scope', 'false-default-classification-knowledge'])('does not bypass disabled retries for %s', async id => {
    const item = captured(id)
    const { model, sent } = client([item.checkerResponses[id === 'false-visible-initial-scope' ? 1 : 0].content, correctedReview(item)], 0)
    expect((await model.reviewGrounding(item.request, item.result)).status).toBe('failed')
    expect(sent).toHaveLength(1)
  })

  it.each(['context', 'packet', 'source', 'event', 'structured-source'])('does not discard actual classification/status information in %s', async location => {
    const item = captured('false-default-classification-knowledge')
    const declaration = 'E-001 source classification: primary document. Verification status: verified.'
    if (location === 'context') item.request.groundingContext += '\n' + declaration
    if (location === 'packet') item.request.packet += '\n' + declaration
    if (location === 'source') item.request.evidence[0].text += ' ' + declaration
    if (location === 'event') item.request.courtroomEvents.push({ eventId: 'known-status', type: 'public_submission', actorId: 'crown', payload: { text: declaration } })
    if (location === 'structured-source') Object.assign(item.request.evidence[0], { sourceClassification: 'primary_document', verificationStatus: 'verified' })
    const draft = { title: '', content: 'Both remain disputed accounts, and their source classification and verification status are not supplied.', citations: [], jurors: [] }
    expect(review(item, false, draft).status).toBe('failed')
  })

  it('treats an explicitly declared unknown status as supplied information', () => {
    const item = captured('false-default-classification-knowledge')
    item.request.packet += '\nVerification status: unknown.'
    const draft = { title: '', content: 'Both remain disputed accounts, and their source classification and verification status are not supplied.', citations: [], jurors: [] }
    expect(review(item, false, draft).status).toBe('failed')
  })

  it('withholds visible-deliberation absence when an actual deliberation event is supplied', async () => {
    const item = captured('false-visible-initial-scope')
    item.request.courtroomEvents.push({ eventId: 'actual-deliberation', type: 'juror_deliberation_turn', phase: 'deliberation', actorId: 'juror-02', payload: { text: 'I weigh the two accounts.' } })
    const { model, sent } = client([correctedReview(item)])
    expect((await model.reviewGrounding(item.request, item.result)).status).toBe('failed')
    expect(sent).toHaveLength(1)
  })

  it('does not infer an empty event inventory when none was supplied', () => {
    const item = captured('false-visible-initial-scope')
    const draft = { title: '', content: '', citations: [], jurors: [{ ...item.result.jurors[0], rationale: '', mindChangedBecause: 'No deliberation is visible.' }] }
    const result = parseGroundingReview(JSON.stringify({ findings: groundingUnits(draft).map(unit => ({ unitId: unit.id, status: 'analysis', explanation: 'Injected offline label.', citations: [], recordCitations: [] })) }), groundingUnits(draft), item.request.evidence, item.request.groundingContext)
    expect(result.status).toBe('failed')
  })
})
