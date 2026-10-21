import { describe, expect, it } from 'vitest'
import recording from '../samples/courtroom-realism/opening-recording.json'
import { createCourtroomFixture } from '../samples/courtroom-realism/fixture'
import { supportedOpeningControl, supportedOpeningRequest } from '../samples/courtroom-realism/supported-opening'
import { MiniMaxClient, type StageRequest } from '../server/minimax'
import { groundingUnits, parseGroundingReview, type GroundingFinding } from '../server/grounding'
import type { StageResult } from '../server/types'

type Body = { messages: Array<{ content: string }> }
const config = { provider: 'openai-compatible' as const, model: 'offline-replay', apiKey: 'fixture', baseUrl: 'http://127.0.0.1:11434/v1', timeoutMs: 1000, maxRetries: 1 }
const response = (value: unknown) => Response.json({ choices: [{ message: { content: JSON.stringify(value) } }] })
function reconstructedDraft(findings: Array<{ unitId: string; text: string }>): StageResult {
  return { title: findings.filter(f => f.unitId.startsWith('title')).map(f => f.text).join(' '), content: findings.filter(f => f.unitId.startsWith('content')).map(f => f.text).join(' '), citations: ['E-001'], jurors: [] }
}
function recordedReview(draft: StageResult, findings: Array<{ text: string; status: string; explanation: string; citations: unknown[] }>) {
  return { findings: groundingUnits(draft).map(unit => {
    const recorded = findings.find(f => f.text === unit.text)
    if (!recorded) throw new Error(`Unrecorded reconstruction unit: ${unit.text}`)
    return { ...recorded, unitId: unit.id }
  }) }
}
async function limitedRequest() {
  let request: StageRequest | undefined
  const f = createCourtroomFixture({ async generateStage(r) { request = r; throw new Error('Offline capture stop') } })
  try { await f.engine.runAutonomous(f.run.id) } catch { /* capture first opening */ }
  const sourceText = f.evidence.text
  f.store.close()
  if (!request) throw new Error('Missing Crown opening')
  expect(sourceText).toBe('Early material fact: notice was delivered.')
  return request
}

describe('Crown opening source-faithfulness: offline replay only', () => {
  it('gives the independent opening checker the actual pinned elements without private theory or generated assertions', async () => {
    const request = await limitedRequest()
    let prompt = ''
    const client = new MiniMaxClient({ ...config, maxRetries: 0 }, undefined, async (_url, init) => {
      prompt = (JSON.parse(String(init?.body)) as Body).messages.map(m => m.content).join('\n')
      return response({ findings: [{ unitId: 'content:1', status: 'unsupported', explanation: 'No participation allegation or three-element charge supplied.', citations: [] }] })
    })
    await client.reviewGrounding({ ...request, previousTurns: 'PRIOR_GENERATED_ASSERTION', packet: request.packet + '\nPrivate theory: PRIVATE_REPAIR_123' }, { title: '', content: 'The accused participated in a transfer.', citations: [], jurors: [] })
    expect(prompt).toContain('Approved issue(s): issue-1: Fictional disputed transfer')
    expect(prompt).toContain('Fictional fixture condition for issue-1-element-1; no statement of applicable law.')
    expect(prompt).not.toContain('CROWN_PRIVATE_713')
    expect(prompt).not.toContain('PRIVATE_REPAIR_123')
    expect(prompt).not.toContain('PRIOR_GENERATED_ASSERTION')
  })

  it('requires checking party-position premises, pinned elements and court-record completeness instead of exempting them as analysis', async () => {
    const request = await limitedRequest()
    let prompt = ''
    let system = ''
    const client = new MiniMaxClient({ ...config, maxRetries: 0 }, undefined, async (_url, init) => {
      const messages = (JSON.parse(String(init?.body)) as Body).messages
      prompt = messages.map(m => m.content).join('\n')
      system = messages[0].content
      throw new Error('Offline checker capture')
    })
    await expect(client.reviewGrounding(request, { title: '', content: 'The Crown alleges the accused participated. The only exhibit before the court is E-001.', citations: [], jurors: [] })).rejects.toThrow('Offline checker capture')
    expect(prompt).toContain('An allegation label does not supply its factual premise')
    expect(prompt).toContain('Do not invent charge elements')
    expect(prompt).toContain('only exhibit before the court')
    expect(prompt).toContain('Promises to meet the burden through later evidence')
    expect(system).toContain('Claiming a party holds a particular factual position is itself a factual premise')
    expect(system).toContain('not a conditional argument')
  })

  it('allows a supplied disputed account without leaking an advocate private strategy into the checker', async () => {
    let prompt = ''
    const client = new MiniMaxClient({ ...config, maxRetries: 0 }, undefined, async (_url, init) => {
      prompt = (JSON.parse(String(init?.body)) as Body).messages.map(m => m.content).join('\n')
      return response({ findings: groundingUnits(supportedOpeningControl).map(unit => ({ unitId: unit.id, status: unit.text.includes('Mira states') ? 'supported' : 'analysis', citations: unit.text.includes('Mira states') ? [{ exhibitId: 'E-101', paragraph: 1 }] : [] })) })
    })
    const review = await client.reviewGrounding({ ...supportedOpeningRequest, packet: supportedOpeningRequest.packet + '\nPrivate theory: PRIVATE_999' }, supportedOpeningControl)
    expect(review.status).toBe('passed')
    expect(prompt).toContain("Approved party position: the Crown relies on Mira's disputed account")
    expect(prompt).not.toContain('PRIVATE_999')
  })

  it('separates case metadata from sources and requires grounded opening categories in the actual outbound prompt', async () => {
    const request = await limitedRequest()
    const bodies: Body[] = []
    const client = new MiniMaxClient({ ...config, maxRetries: 0 }, undefined, async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body))); throw new Error('Offline transport stop')
    })
    await expect(client.generateStage(request)).rejects.toThrow('Offline transport stop')
    const prompt = bodies[0].messages.map(m => m.content).join('\n')
    expect(prompt).toContain('Opening claim contract')
    expect(prompt).toContain('Approved allegation or party position')
    expect(prompt).toContain('Source-grounded preview')
    expect(prompt).toContain('Unknown or unsupported')
    expect(prompt).toContain('not necessarily the only filed or disclosed exhibit')
    expect(prompt).not.toContain('The uploaded case packet is relevant evidence.')
    expect(prompt).not.toContain('Set out the strongest pleaded allegations, corroborating exhibits, chronology, reliance or loss theory')
    expect(prompt).toContain('Notice only; not proof of truth')
    expect(request.evidence.map(e => e.exhibitId)).toEqual(['E-001'])
    expect(JSON.stringify(request)).not.toContain('OTHER_WITNESS_527')
  })

  it('withholds the recorded original and repair, retaining the chronological reasons without live calls', async () => {
    const request = await limitedRequest()
    const bodies: Body[] = []
    const drafts = [reconstructedDraft(recording.original.findings), reconstructedDraft(recording.repaired.findings)]
    let authors = 0
    const client = new MiniMaxClient(config, undefined, async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Body; bodies.push(body)
      if (body.messages[1].content.startsWith('Stage: factual_verification')) return response(recordedReview(drafts[authors - 1], authors === 1 ? recording.original.findings : recording.repaired.findings))
      return response(drafts[authors++])
    })
    await expect(client.generateStage(request)).rejects.toMatchObject({ grounding: { status: 'failed', repairs: 1,
      priorFailures: [{ errors: [expect.stringContaining(recording.original.errors[0].split('unsupported — ')[1])] }], errors: expect.arrayContaining([expect.stringContaining('repair drift')]) } })
    expect(bodies).toHaveLength(3)
    const repairPrompt = bodies[2].messages.map(m => m.content).join('\n')
    expect(repairPrompt).toContain(recording.original.findings.find(f => f.status === 'unsupported')!.text)
    expect(repairPrompt).toContain('Opening claim contract')
    expect(bodies[1].messages[1].content).not.toContain('CROWN_PRIVATE_713')
    expect(repairPrompt).toContain(JSON.stringify(drafts[0]))
  })

  it.each([
    ['transfer', "The Crown's position, to be tested through evidence you will hear, is that a transfer occurred and that the accused was a party to it."],
    ['participation', "The Crown's position, to be tested through evidence you will hear, is that a transfer occurred and that the accused was a party to it."],
    ['complete filing', "The Crown's only filed exhibit at this point is E-001 (notice.txt)."],
  ])('rejects the recorded %s claim on the unchanged notice fixture', async (_label, text) => {
    const request = await limitedRequest()
    const finding = [...recording.original.findings, ...recording.repaired.findings].find(f => f.text === text && f.status === 'unsupported')!
    expect(finding).toBeDefined()
    const review = parseGroundingReview(JSON.stringify({ findings: [{ ...finding, unitId: 'content:1', citations: [{ exhibitId: 'E-001', paragraph: 1 }] }] }), [{ id: 'content:1', text }], request.evidence)
    expect(review.status).toBe('failed')
    expect(review.findings[0].citations[0].quote).toBe('Early material fact: notice was delivered.')
  })

  it('accepts a useful qualified account preview under unchanged verification rather than withholding everything', async () => {
    let calls = 0
    const units = groundingUnits(supportedOpeningControl)
    const findings: GroundingFinding[] = units.map(unit => ({ ...unit, unitId: unit.id, status: unit.text.includes('Mira states') ? 'supported' : 'analysis', explanation: unit.text.includes('Mira states') ? 'Attributed account matches the source, including uncertainty about contents.' : 'Procedural roadmap or expressly qualified inference; no assertion of contents or guilt.', citations: [] }))
    const client = new MiniMaxClient({ ...config, maxRetries: 0 }, undefined, async () => {
      calls++
      return response(calls === 1 ? supportedOpeningControl : { findings: findings.map(f => ({ ...f, citations: f.status === 'supported' ? [{ exhibitId: 'E-101', paragraph: 1 }] : [] })) })
    })
    const result = await client.generateStage(supportedOpeningRequest)
    expect(result.content).toBe(supportedOpeningControl.content)
    expect(result.grounding).toMatchObject({ status: 'passed', repairs: 0 })
    expect(result.grounding!.findings.some(f => f.status === 'supported')).toBe(true)
    expect(calls).toBe(2)
  })

  it('does not turn a valid source ID or an allegation label into permission to invent envelope contents', () => {
    const text = 'The Crown alleges that the envelope contained cash [E-101].'
    const review = parseGroundingReview(JSON.stringify({ findings: [{ unitId: 'content:1', status: 'unsupported', explanation: 'The account expressly does not know the contents. The allegation is not supplied in approved materials.', citations: [{ exhibitId: 'E-101', paragraph: 1 }] }] }), [{ id: 'content:1', text }], supportedOpeningRequest.evidence)
    expect(review.status).toBe('failed')
    const forged = parseGroundingReview(JSON.stringify({ findings: [{ unitId: 'content:1', status: 'supported', citations: [{ exhibitId: 'E-101', paragraph: 1, quote: 'The envelope contained cash.' }] }] }), [{ id: 'content:1', text }], supportedOpeningRequest.evidence)
    expect(forged.status).toBe('failed')
  })
})
