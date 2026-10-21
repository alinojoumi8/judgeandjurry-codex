import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { MiniMaxClient } from '../server/minimax'
import { resegmentMetadataControl } from './resegmentMetadataControl'

const capture = JSON.parse(readFileSync('docs/qa/jury/v219-captured-control-failures.json', 'utf8')).items[0]
function fixture() {
  const { control, checkerResponses } = structuredClone(capture)
  const bad = JSON.parse(checkerResponses[0].content)
  const good = structuredClone(bad)
  for (const finding of good.findings) if (['content:5', 'content:6'].includes(finding.unitId)) Object.assign(finding, {
    status: 'analysis', explanation: 'The complete statement preserves unknown source metadata and the actual Crown proof obligation; it asserts no proof finding.', citations: [], recordCitations: [],
  })
  return { request: control.request, draft: control.draft, bad: JSON.parse(resegmentMetadataControl(JSON.stringify(bad))), good: JSON.parse(resegmentMetadataControl(JSON.stringify(good))) }
}
function client(outputs: any[], maxRetries = 2) {
  const sent: any[] = []
  const model = new MiniMaxClient({ provider: 'minimax', apiKey: 'fictional', baseUrl: 'https://fixture.invalid/v1', model: 'fixture', timeoutMs: 2000, maxRetries }, undefined, async (_url, init) => {
    sent.push(JSON.parse(String(init?.body)))
    const value = outputs[Math.min(sent.length - 1, outputs.length - 1)]
    return Response.json({ choices: [{ message: { content: typeof value === 'string' ? value : JSON.stringify(value) } }] })
  })
  return { model, sent }
}
function alterLegal(request: any, mutate: (value: any) => void) {
  request.packet = request.packet.split('\n').map((line: string) => {
    const match = line.match(/^(Pinned legal packet [a-f0-9]+: )(.+)$/)
    if (!match) return line
    const value = JSON.parse(match[2]); mutate(value)
    return match[1] + JSON.stringify(value)
  }).join('\n')
}

describe('checker objection to the supplied Crown burden statement', () => {
  it('requires a valid new review of both objections in the actual captured draft', async () => {
    const f = fixture(), { model, sent } = client([f.bad, f.good])
    const result = await model.reviewGrounding(f.request, f.draft)
    expect(result.status).toBe('passed')
    expect(result.verificationRetries).toBe(1)
    expect(sent).toHaveLength(2)
    expect(sent[1].messages.at(-1).content).toContain('SAME')
  })
  it('adds no calls to a valid first review', async () => {
    const f = fixture(), { model, sent } = client([f.good])
    expect((await model.reviewGrounding(f.request, f.draft)).status).toBe('passed')
    expect(sent).toHaveLength(1)
  })
  it('withholds repeated unchanged objections at the existing ceiling', async () => {
    const f = fixture(), { model, sent } = client([f.bad])
    expect((await model.reviewGrounding(f.request, f.draft)).status).toBe('failed')
    expect(sent).toHaveLength(3)
  })
  it('honors disabled retries', async () => {
    const f = fixture(), { model, sent } = client([f.bad, f.good], 0)
    expect((await model.reviewGrounding(f.request, f.draft)).status).toBe('failed')
    expect(sent).toHaveLength(1)
  })
  it('does not accept an invalid second review', async () => {
    const f = fixture()
    const domains: Record<string, string[]> = { 'title:1': ['analysis'], 'content:1': ['record'], 'content:2': ['source'], 'content:3': ['source'], 'content:4': ['source_use'], 'content:5': ['analysis'], 'content:6': ['instruction'] }
    const complete = { findings: f.good.findings.map((row: any) => ({ ...row, supportTypes: domains[row.unitId], recordCitations: row.recordCitations.map((eventId: string) => ({ eventId })) })) }
    const { model, sent } = client([f.bad, 'invalid JSON', complete])
    expect((await model.reviewGrounding(f.request, f.draft)).status).toBe('passed')
    expect(sent).toHaveLength(3)
  })
  it('withholds a separate substantive failure', async () => {
    const f = fixture()
    Object.assign(f.bad.findings.find((x: any) => x.unitId === 'content:2'), { status: 'unsupported', explanation: 'Separate source-comparison failure.' })
    const { model, sent } = client([f.bad, f.good])
    expect((await model.reviewGrounding(f.request, f.draft)).status).toBe('failed')
    expect(sent).toHaveLength(1)
  })
  it.each(['party', 'standard', 'missing', 'multiple', 'known-metadata'])('preserves actual contrary or missing setup: %s', async scope => {
    const f = fixture()
    if (scope === 'party') alterLegal(f.request, p => p.issues[0].elements[0].burdenPartyId = 'accused-1')
    if (scope === 'standard') alterLegal(f.request, p => p.issues[0].elements[0].standard = 'balance of probabilities')
    if (scope === 'multiple') alterLegal(f.request, p => p.issues[0].elements.push({ ...p.issues[0].elements[0], elementId: 'another' }))
    if (scope === 'missing') f.request.packet = f.request.packet.split('\n').filter((line: string) => !line.startsWith('Pinned legal packet ')).join('\n')
    if (scope === 'known-metadata') f.request.packet += '\nVerification status: verified.'
    const { model, sent } = client([f.bad, f.good])
    expect((await model.reviewGrounding(f.request, f.draft)).status).toBe('failed')
    expect(sent).toHaveLength(1)
  })
  it.each([
    '“The Crown bears the fictional condition beyond a reasonable doubt.”',
    'If the Crown bears the fictional condition beyond a reasonable doubt, I would agree.',
    'The Crown does not bear the fictional condition beyond a reasonable doubt.',
    'The Crown bears the fictional condition beyond a reasonable doubt, so receipt is proved.',
    'The Crown bears the fictional condition beyond a reasonable doubt because Ellis acted knowingly.',
  ])('does not expand the complete current instruction scope: %s', async wording => {
    const f = fixture()
    f.draft.content = f.draft.content.replace('The Crown bears the fictional condition beyond a reasonable doubt.', wording)
    const { model, sent } = client([f.bad, f.good])
    expect((await model.reviewGrounding(f.request, f.draft)).status).toBe('failed')
    expect(sent).toHaveLength(1)
  })
})
