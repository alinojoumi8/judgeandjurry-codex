import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MiniMaxClient } from '../server/minimax'

const capture = JSON.parse(readFileSync('docs/qa/jury/v189-captured-authentication-epistemic-scope.json', 'utf8'))
async function auditSetup(request: any) {
  const sent: any[] = []
  const original = JSON.stringify(request)
  const client = new MiniMaxClient({ provider: 'minimax', apiKey: 'fictional', baseUrl: 'https://fixture.invalid/v1', model: 'fixture', timeoutMs: 2000, maxRetries: 0 }, undefined, async (_url, init) => {
    sent.push(JSON.parse(String(init?.body)))
    return Response.json({ choices: [{ message: { content: capture.reviews[2].content } }] })
  })
  const review = await client.reviewGrounding(request, capture.result)
  expect(review.status).toBe('failed') // No automatic acceptance of the replayed negative review.
  expect(sent).toHaveLength(1)
  expect(JSON.stringify(request)).toBe(original)
  const line = sent[0].messages[0].content.split('\n').find((value: string) => value.startsWith('Approved authentication knowledge: '))
  return line ? JSON.parse(line.slice('Approved authentication knowledge: '.length)) : undefined
}
describe('authentication knowledge derived from actual audit setup', () => {
  it('supplies epistemic knowledge for the actual explicitly missing statuses without inventing authentication values', async () => {
    expect(await auditSetup(capture.request)).toEqual([
      { exhibitId: 'E-001', informationProvided: false, knowledgeWithinSuppliedRecord: 'unknown' },
      { exhibitId: 'E-002', informationProvided: false, knowledgeWithinSuppliedRecord: 'unknown' },
    ])
  })
  it('derives knowledge only for the actual supplied source inventory', async () => {
    const request = structuredClone(capture.request)
    request.evidence = request.evidence.slice(0, 1)
    expect(await auditSetup(request)).toEqual([{ exhibitId: 'E-001', informationProvided: false, knowledgeWithinSuppliedRecord: 'unknown' }])
  })
  it('does not assume omitted source metadata is an explicit missing-status declaration', async () => {
    expect(await auditSetup({ ...capture.request, groundingContext: '' })).toBeUndefined()
  })
  it('does not apply the complete-inventory interpretation to mixed known and missing statuses', async () => {
    const request = structuredClone(capture.request)
    request.groundingContext = request.groundingContext.replace('Disclosure, oath and authentication status not supplied.', 'Authentication status: authenticated.')
    expect(await auditSetup(request)).toBeUndefined()
  })
  it('does not disregard a known contrary authentication declaration in the approved packet', async () => {
    expect(await auditSetup({ ...capture.request, packet: capture.request.packet + '\nAuthentication status: authenticated.' })).toBeUndefined()
  })
  it('does not add courtroom audit setup outside the protocol', async () => {
    expect(await auditSetup({ ...capture.request, courtroomProtocol: false })).toBeUndefined()
  })
})
