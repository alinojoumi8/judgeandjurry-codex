import { describe, expect, it } from 'vitest'
import { groundingUnits, parseGroundingReview } from '../server/grounding'
import { MiniMaxClient } from '../server/minimax'
import type { EvidenceItem } from '../server/types'

const evidence = [{ id: 'ev1', exhibitId: 'E-001', name: 'payment.txt', text: 'Fictional Cedar Markets received $573,219 from Fictional Maple Trading.' }] as EvidenceItem[]
const quote = evidence[0].text
const citation = { exhibitId: 'E-001', paragraph: 1, quote }

describe('factual source checks', () => {
  it('does not turn unknown contents into an acknowledged lack of contents under either acceptance label', () => {
    const record = [{ ...evidence[0], text: 'Mira saw Rowan hand the sealed envelope to Ellis. I do not know what the envelope contained.' }]
    for (const status of ['supported', 'analysis']) {
      const units = [{ id: 'content:1', text: 'The account attributes a transfer direction and an acknowledged lack of contents.' }]
      const result = parseGroundingReview(JSON.stringify({ findings: [{ unitId: 'content:1', status, citations: [{ exhibitId: 'E-001', paragraph: 1 }] }] }), units, record)
      expect(result.status).toBe('failed')
      expect(result.findings[0].status).toBe('unsupported')
      expect(result.validationErrors).toEqual([])
    }
  })
  it('preserves an explicit empty-envelope source and a rejection of the absence inference', () => {
    for (const [text, source] of [
      ['The account records a lack of contents.', 'Mira states: The envelope was empty.'],
      ['Unknown contents are not an acknowledged lack of contents.', 'Mira states: I do not know what the envelope contained.'],
      ['The account does not prove that the envelope was empty.', 'Mira states: I do not know what the envelope contained.'],
    ]) {
      const result = parseGroundingReview(JSON.stringify({ findings: [{ unitId: 'content:1', status: 'supported', citations: [{ exhibitId: 'E-001', paragraph: 1 }] }] }), [{ id: 'content:1', text }], [{ ...evidence[0], text: source }])
      expect(result.status).toBe('passed')
    }
  })
  it('requires every unit and an actual matching passage, not just a valid exhibit ID', () => {
    const units = [{ id: 'content:1', text: quote }]
    expect(parseGroundingReview(JSON.stringify({ findings: [{ unitId: 'content:1', status: 'supported', citations: [citation] }] }), units, evidence).status).toBe('passed')
    expect(parseGroundingReview(JSON.stringify({ findings: [] }), units, evidence).status).toBe('failed')
    expect(parseGroundingReview(JSON.stringify({ findings: [{ unitId: 'content:1', status: 'supported', citations: [{ ...citation, quote: 'A fabricated passage about $573,219.' }] }] }), units, evidence).status).toBe('failed')
    const corrected = parseGroundingReview(JSON.stringify({ findings: [{ unitId: 'content:1', status: 'supported', citations: [{ ...citation, paragraph: 2 }] }] }), units, evidence)
    expect(corrected.status).toBe('passed')
    expect(corrected.citationCorrections).toEqual([{ unitId: 'content:1', exhibitId: 'E-001', fromParagraph: 2, toParagraph: 1 }])
    expect(corrected.findings[0].citations[0].paragraph).toBe(1)
    expect(parseGroundingReview(JSON.stringify({ findings: [{ unitId: 'content:1', status: 'supported', citations: [citation] }] }), units, []).status).toBe('failed')
  })

  it('rejects a changed amount and prevents payment assertions being passed as pure analysis', () => {
    const units = [{ id: 'content:1', text: 'Fictional Cedar Markets received $900,000 from Fictional Maple Trading.' }]
    for (const status of ['supported', 'analysis']) {
      expect(parseGroundingReview(JSON.stringify({ findings: [{ unitId: 'content:1', status, citations: [citation] }] }), units, evidence).status).toBe('failed')
    }
  })

  it('resolves cited paragraphs to original text without relying on model-transcribed quotations', () => {
    const units = [{ id: 'content:1', text: quote }]
    const data = { findings: [{ unitId: 'content:1', status: 'supported', citations: [{ exhibitId: 'E-001', paragraph: 1 }] }] }
    const review = parseGroundingReview(JSON.stringify(data), units, evidence)
    expect(review.status).toBe('passed')
    expect(review.findings[0].citations[0]).toMatchObject({ quote, quoteMethod: 'source-paragraph', paragraph: 1 })
    data.findings[0].citations[0].paragraph = 99
    expect(parseGroundingReview(JSON.stringify(data), units, evidence).status).toBe('failed')
  })

  it('checks monetary scale rather than treating three dollars and three million as equal', () => {
    const units = [{ id: 'content:1', text: 'The recipient received $3 million.' }]
    const data = JSON.stringify({ findings: [{ unitId: 'content:1', status: 'supported', citations: [{ exhibitId: 'E-001', paragraph: 1 }] }] })
    expect(parseGroundingReview(data, units, [{ ...evidence[0], text: 'The recipient received $3.' }]).status).toBe('failed')
    expect(parseGroundingReview(data, units, [{ ...evidence[0], text: 'The recipient received CAD 3,000,000.00.' }]).status).toBe('passed')
  })

  it('withholds a direction reversal, repairs it and preserves the rejected claim in the audit', async () => {
    const requests: Array<{ messages: Array<{ content: string }> }> = []
    let drafts = 0
    const client = new MiniMaxClient({ provider: 'minimax', apiKey: 'test', baseUrl: 'https://api.minimax.io/v1', model: 'test', timeoutMs: 2000, maxRetries: 1 }, undefined, async (_url, init) => {
      const body = JSON.parse(String(init?.body))
      requests.push(body)
      const prompt: string = body.messages[1].content
      if (prompt.includes('Stage: factual_verification')) {
        const units = JSON.parse(prompt.split('Draft units to check:\n')[1]) as Array<{ id: string; text: string }>
        return Response.json({ choices: [{ message: { content: JSON.stringify({ findings: units.map((unit) => ({ unitId: unit.id, status: unit.id.startsWith('title') ? 'analysis' : drafts === 1 ? 'contradicted' : 'supported', explanation: drafts === 1 ? 'The sender and recipient are reversed.' : 'The direction and amount match the source.', citations: unit.id.startsWith('title') ? [] : [citation] })) }) } }] })
      }
      drafts++
      return Response.json({ choices: [{ message: { content: JSON.stringify({ title: 'Payment account', content: drafts === 1 ? 'Fictional Maple Trading received $573,219 from Fictional Cedar Markets [E-001].' : 'Fictional Cedar Markets received $573,219 from Fictional Maple Trading [E-001].', citations: ['E-001'], jurors: [] }) } }] })
    })
    const result = await client.generateStage({ stage: 'crown_rebuttal', packet: 'PRIVATE_STRATEGY\nActor: crown', evidence, previousTurns: '', groundingRequired: true })
    expect(result.content).toContain('Fictional Cedar Markets received')
    expect(result.grounding).toMatchObject({ status: 'passed', repairs: 1 })
    expect(result.grounding?.priorFailures?.[0].findings.some((finding) => finding.status === 'contradicted')).toBe(true)
    expect(requests).toHaveLength(4)
    expect(requests[1].messages[1].content).not.toContain('PRIVATE_STRATEGY')
    expect(requests[2].messages[1].content).toContain('The sender and recipient are reversed')
  })

  it('fails closed when the checker cannot verify a factual response', async () => {
    let calls = 0
    const draft = { title: 'Payment', content: quote, citations: ['E-001'] }
    const units = groundingUnits(draft)
    const client = new MiniMaxClient({ provider: 'minimax', apiKey: 'test', baseUrl: 'https://api.minimax.io/v1', model: 'test', timeoutMs: 2000, maxRetries: 0 }, undefined, async () => {
      calls++
      return Response.json({ choices: [{ message: { content: JSON.stringify(calls === 1 ? draft : { findings: units.map((unit) => ({ unitId: unit.id, status: 'unsupported', explanation: 'Insufficient source support.', citations: [] })) }) } }] })
    })
    await expect(client.generateStage({ stage: 'crown_opening', packet: '', evidence, previousTurns: '', groundingRequired: true })).rejects.toMatchObject({ grounding: { status: 'failed' } })
  })

  it('repairs a checker quotation without regenerating the supported advocate draft', async () => {
    let authorCalls = 0
    let checks = 0
    const client = new MiniMaxClient({ provider: 'minimax', apiKey: 'test', baseUrl: 'https://api.minimax.io/v1', model: 'test', timeoutMs: 2000, maxRetries: 1 }, undefined, async (_url, init) => {
      const prompt = JSON.parse(String(init?.body)).messages[1].content as string
      if (!prompt.startsWith('Stage: factual_verification')) {
        authorCalls++
        return Response.json({ choices: [{ message: { content: JSON.stringify({ title: 'Payment', content: quote, citations: ['E-001'] }) } }] })
      }
      checks++
      if (checks === 2) expect(prompt).toContain('Verification-format correction needed')
      const units = JSON.parse(prompt.split('Draft units to check:\n')[1]) as Array<{ id: string }>
      return Response.json({ choices: [{ message: { content: JSON.stringify({ findings: units.map((unit) => ({ unitId: unit.id, status: unit.id.startsWith('title') ? 'analysis' : 'supported', explanation: 'Payment direction and amount match.', citations: unit.id.startsWith('title') ? [] : [{ ...citation, quote: checks === 1 ? 'Fictional Cedar Markets accepted $573,219 from Fictional Maple Trading.' : quote }] })) }) } }] })
    })
    const result = await client.generateStage({ stage: 'crown_opening', packet: '', evidence, previousTurns: '', groundingRequired: true })
    expect(authorCalls).toBe(1)
    expect(checks).toBe(2)
    expect(result.grounding).toMatchObject({ status: 'passed', repairs: 0, verificationRetries: 1 })
  })
})
