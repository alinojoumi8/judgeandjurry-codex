import { describe, expect, it } from 'vitest'
import type { GroundingUnit } from '../server/grounding'
import { MiniMaxClient, type StageRequest } from '../server/minimax'
import { supportedOpeningSource } from '../samples/courtroom-realism/supported-opening'

const restriction = 'E-001: limited; permitted purposes: Attribute the interview answers only; prohibited purposes: Treat the account as proof that the described events occurred.'
const good = 'Mira states that a blue token lay on the desk (E-001).'
const bad = 'The Crown must treat those answers as requiring assessment, not automatically as truth (E-001, paragraph 1).'
const repaired = 'Under the supplied source-use restrictions, the interview answers may be attributed only; they do not establish that the described events occurred.'
const draft = { title: 'Closing assessment', content: `${good} ${bad}`, citations: ['E-001'], jurors: [] }
const request: StageRequest = { stage: 'crown_rebuttal', packet: `Source-use restrictions:\n${restriction}`, groundingContext: `Source-use restrictions:\n${restriction}`, previousTurns: '', groundingRequired: true,
  evidence: [{ ...supportedOpeningSource, exhibitId: 'E-001', text: 'Mira states that a blue token lay on the desk.' }] }
type Body = { messages: Array<{ role: string; content: string }> }
function harness(replacement = repaired, rejectRepair = false) {
  const bodies: Body[] = []
  let authors = 0
  const client = new MiniMaxClient({ provider: 'openai-compatible', apiKey: 'fixture', baseUrl: 'https://fixture.invalid/v1', model: 'fictional', timeoutMs: 1000, maxRetries: 1 }, undefined, async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as Body; bodies.push(body)
    const prompt = body.messages[1].content
    const units: GroundingUnit[] | undefined = prompt.includes('Draft units to check:\n') ? JSON.parse(prompt.split('Draft units to check:\n')[1]) : undefined
    const result = units ? { findings: Object.fromEntries(units.map(unit => [unit.id, {
      status: unit.text === bad || (rejectRepair && unit.text === replacement) ? 'unsupported' : unit.text === good ? 'supported' : 'analysis',
      supportTypes: unit.text === good ? ['source'] : unit.text === bad || unit.text === replacement ? ['source_use'] : ['analysis'],
      explanation: unit.text === bad ? 'The cited transcript paragraph supplies the attributed observation, not the application source-use restriction.' : rejectRepair && unit.text === replacement ? 'The replacement still claims a proof permission absent from the supplied restriction.' : unit.text === replacement ? 'The supplied application restriction permits attribution only; the replacement preserves that limit without a transcript citation.' : 'Verified attributed account or neutral heading.',
      citations: unit.text === good || unit.text === bad ? [{ exhibitId: 'E-001', paragraph: 1 }] : [], recordCitations: [],
    }])) } : ++authors === 1 ? draft : { repairs: [{ unitId: 'content:2', replacement }] }
    return Response.json({ choices: [{ message: { content: JSON.stringify(result) } }] })
  })
  return { client, bodies }
}

describe('application source-use explanation citation repair', () => {
  it('repairs only the rejected explanation and independently checks the complete draft against the actual setup', async () => {
    const h = harness()
    const result = await h.client.generateStage(request)
    expect(result.grounding?.status).toBe('passed')
    expect(result.content).toBe(`${good} ${repaired}`)
    expect(result.title).toBe(draft.title)
    expect(result.grounding?.appliedRepairs).toEqual([{ unitId: 'content:2', before: bad, replacement: repaired }])
    expect(result.grounding?.priorFailures?.[0].findings).toEqual(expect.arrayContaining([expect.objectContaining({ text: bad, status: 'unsupported' })]))
    const author = h.bodies[0].messages[1].content
    const repair = h.bodies.find(body => body.messages[1].content.includes('OUTPUT CONTRACT FOR THIS REPAIR'))!.messages[1].content
    expect(author).toContain('Keep application source-use explanations in a separate setup sentence')
    expect(repair).toContain('Repair source-use claims against the actual supplied restrictions')
    const finalCheck = h.bodies.at(-1)!.messages[1].content
    expect(finalCheck).toContain(restriction)
    expect(finalCheck).toContain(repaired)
    expect(finalCheck).not.toContain(bad)
    expect(result.grounding?.findings.find(finding => finding.text === repaired)).toMatchObject({ status: 'analysis', supportTypes: ['source_use'], citations: [] })
  })

  it('keeps an unchanged unsupported source-use explanation withheld', async () => {
    const h = harness(bad)
    await expect(h.client.generateStage(request)).rejects.toMatchObject({ grounding: { status: 'failed', findings: expect.arrayContaining([expect.objectContaining({ text: bad, status: 'unsupported' })]) } })
  })

  it('does not let removing the transcript citation override an independent proof-permission rejection', async () => {
    const replacement = 'Under the supplied source-use restrictions, the interview answers prove that Rowan received the token.'
    const h = harness(replacement, true)
    await expect(h.client.generateStage(request)).rejects.toMatchObject({ grounding: { status: 'failed', findings: expect.arrayContaining([expect.objectContaining({ text: replacement, status: 'unsupported' })]) } })
  })
})
