import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MiniMaxClient } from '../server/minimax'

const capture = JSON.parse(readFileSync('docs/qa/jury/v185-captured-negation-and-authentication.json', 'utf8'))
const [adverbs, resultPredicate, authentication] = capture.items
function comparisonDraft(item: any) {
  const result = structuredClone(item.result)
  // Isolate the faithful comparison from the independently unsupported history
  // claim in the preserved original; the original remains a negative scope case.
  if (item.id === 'input-1-author-1') result.jurors[0].mindChangedBecause = 'This is my initial ballot, and no visible deliberation event is supplied.'
  return result
}
function harness(outputs: string[], maxRetries = 2) {
  const sent: any[] = []
  const client = new MiniMaxClient({ provider: 'minimax', apiKey: 'fictional', baseUrl: 'https://fixture.invalid/v1', model: 'fixture', timeoutMs: 2000, maxRetries }, undefined, async (_url, init) => {
    sent.push(JSON.parse(String(init?.body)))
    return Response.json({ choices: [{ message: { content: outputs[Math.min(sent.length - 1, outputs.length - 1)] } }] })
  })
  return { client, sent }
}
const correctedAuthentication = JSON.parse(authentication.checkerContent)
const metadata = correctedAuthentication.findings.find((x: any) => x.unitId === 'juror-0:2')
metadata.status = 'analysis'
metadata.explanation = 'Authentication status is not supplied, so it remains unknown within this record. This personal assessment neither asserts unauthentication nor a generic verification-status field.'
const validAuthentication = JSON.stringify(correctedAuthentication)

describe('captured negative predicates and epistemic authentication scope', () => {
  it.each([adverbs, resultPredicate])('preserves the actual negative comparisons in $id with record-scoped metadata', async item => {
    const { client, sent } = harness([item.checkerContent], 0)
    const review = await client.reviewGrounding(item.request, comparisonDraft(item))
    expect(review.status, JSON.stringify(review)).toBe('passed')
    expect(sent).toHaveLength(1)
  })
  it('rechecks the actual not-supplied versus unknown authentication misreading on the same draft', async () => {
    const { client, sent } = harness([authentication.checkerContent, validAuthentication])
    const review = await client.reviewGrounding(authentication.request, authentication.result)
    expect(review.status, JSON.stringify(review)).toBe('passed')
    expect(review.verificationRetries).toBe(1)
    expect(sent).toHaveLength(2)
    expect(sent.every(x => x.messages[1].content.includes(authentication.result.jurors[0].rationale))).toBe(true)
    expect(sent[1].messages[1].content).toContain('authentication-status scope mismatch')
  })
  it('withholds repeated invalid authentication reviews at the existing retry limit', async () => {
    const { client, sent } = harness([authentication.checkerContent])
    const review = await client.reviewGrounding(authentication.request, authentication.result)
    expect(review.status).toBe('failed')
    expect(review.verificationRetries).toBe(2)
    expect(sent).toHaveLength(3)
  })
  it('retains authentication rejection when retries are disabled', async () => {
    const { client, sent } = harness([authentication.checkerContent], 0)
    expect((await client.reviewGrounding(authentication.request, authentication.result)).status).toBe('failed')
    expect(sent).toHaveLength(1)
  })
  it('does not infer an authentication status from omitted setup', async () => {
    const request = { ...authentication.request, groundingContext: '' }
    const { client, sent } = harness([authentication.checkerContent])
    expect((await client.reviewGrounding(request, authentication.result)).status).toBe('failed')
    expect(sent).toHaveLength(1)
  })
  it('retains rejection when actual authentication information is supplied', async () => {
    const request = { ...authentication.request, groundingContext: authentication.request.groundingContext.replaceAll('Disclosure, oath and authentication status not supplied.', 'Authentication status: verified authenticated.') }
    const { client, sent } = harness([authentication.checkerContent])
    expect((await client.reviewGrounding(request, authentication.result)).status).toBe('failed')
    expect(sent).toHaveLength(1)
  })
  it('does not confuse generic verification status with the actual authentication field', async () => {
    const result = structuredClone(authentication.result)
    result.jurors[0].rationale = result.jurors[0].rationale.replace('unknown authentication status', 'unknown verification status')
    const { client, sent } = harness([authentication.checkerContent])
    expect((await client.reviewGrounding(authentication.request, result)).status).toBe('failed')
    expect(sent).toHaveLength(1)
  })
  it('retains a separate substantive source failure alongside unknown authentication', async () => {
    const bad = JSON.parse(authentication.checkerContent)
    const content = bad.findings.find((x: any) => x.unitId === 'content:1')
    content.status = 'unsupported'
    content.explanation = 'A separate unsupported source assertion needs correction.'
    const { client, sent } = harness([JSON.stringify(bad)])
    expect((await client.reviewGrounding(authentication.request, authentication.result)).status).toBe('failed')
    expect(sent).toHaveLength(1)
  })
  it.each(['but', 'and', 'while', 'yet'])('retains a separate affirmative conflict after a negative result predicate joined by %s', async join => {
    const result = structuredClone(resultPredicate.result)
    result.content = `The unspecified relative timing does not make those accounts incompatible, ${join} those accounts are incompatible.`
    const { client, sent } = harness([resultPredicate.checkerContent], 0)
    expect((await client.reviewGrounding(resultPredicate.request, result)).status).toBe('failed')
    expect(sent).toHaveLength(1)
  })
  it('retains a separate affirmative conflict after the negated coordinated complement', async () => {
    const result = comparisonDraft(adverbs)
    result.jurors[0].rationale = 'Tavi non-observation is not an express denial or necessarily incompatible, but the accounts are incompatible.'
    const { client, sent } = harness([adverbs.checkerContent], 0)
    expect((await client.reviewGrounding(adverbs.request, result)).status).toBe('failed')
    expect(sent).toHaveLength(1)
  })
  it.each([',', ':'])('retains a separately asserted incompatibility after punctuation %s', async punctuation => {
    const result = structuredClone(resultPredicate.result)
    result.content = `The unspecified relative timing does not make those accounts incompatible${punctuation} those accounts are incompatible.`
    const { client, sent } = harness([resultPredicate.checkerContent], 0)
    expect((await client.reviewGrounding(resultPredicate.request, result)).status).toBe('failed')
    expect(sent).toHaveLength(1)
  })
})
