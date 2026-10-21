import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { groundingMessages } from '../server/grounding'
import { groundingSupportTypesContract } from '../server/groundingFormat'
import { MiniMaxClient } from '../server/minimax'

const baseline = JSON.parse(readFileSync('tests/fixtures/juror-checker-prompt-baseline.json', 'utf8'))
const capture = JSON.parse(readFileSync('docs/qa/jury/v166-captured-correct-low-profile-mixed-assessment.json', 'utf8'))
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const author = { id: 'juror-01', name: 'juror-01', roles: ['juror'] }
const unit = { id: 'content:1', text: 'I assess the supplied record.' }
const marker = 'Approved draft author metadata:'

async function checkerContext(request = capture.request) {
  let context = ''
  const client = new MiniMaxClient({ provider: 'minimax', apiKey: 'fictional', baseUrl: 'https://fixture.invalid/v1',
    model: 'fixture', timeoutMs: 2000, maxRetries: 0 }, undefined, async (_url, init) => {
    context = JSON.parse(String(init?.body)).messages[1].content
    return Response.json({ choices: [{ message: { content: '{"findings":[{"unitId":"content:1","status":"analysis","citations":[]}]}' } }] })
  })
  await client.reviewGrounding(request, { title: '', content: 'My current assessment leaves doubt.', citations: [], jurors: [] })
  return context
}

describe('checker reusable prefix preserves every existing instruction', () => {
  it.each([false, true])('preserves baseline rule bytes alongside the explicit domain shape (opening=%s)', opening => {
    const text = groundingMessages([unit], [], '', undefined, opening, author)[0].content
    const offset = text.indexOf(marker)
    expect(offset).toBeGreaterThan(38000)
    const before = baseline.modes.find((row: { opening: boolean }) => row.opening === opening)
    const staticRules = text.slice(0, offset).trimEnd()
    expect(staticRules.split(groundingSupportTypesContract)).toHaveLength(2)
    expect(hash(staticRules.replace(groundingSupportTypesContract + ' ', ''))).toBe(before.staticRulesSha256)
    expect(hash(text.slice(offset))).toBe(before.variableAuthoritySha256)
  })
  it.each([false, true])('shares the same static prefix across different authors and unit inventories (opening=%s)', opening => {
    const first = groundingMessages([unit], [], '', undefined, opening, author)[0].content
    const second = groundingMessages([{ id: 'content:99', text: 'A different draft.' }], [], '', undefined, opening,
      { id: 'juror-02', name: 'Other juror', roles: ['foreperson'] })[0].content
    expect(first.slice(0, first.indexOf(marker))).toHaveLength(baseline.modes.find((row: { opening: boolean }) => row.opening === opening).staticCharacters + groundingSupportTypesContract.length + 2)
    expect(first.slice(0, first.indexOf(marker))).toBe(second.slice(0, second.indexOf(marker)))
    expect(second).toContain('"content:99"')
    expect(second).toContain('"juror-02"')
  })
})

describe('checker receives explicit bands on the actual 0 to 100 scale', () => {
  it('labels the captured low traits without promoting their assessment to proof', async () => {
    const text = await checkerContext()
    expect(text).toContain('Approved current juror trait bands (0-100 scale; low <=30, high >=70, otherwise moderate; assessment traits, not evidence): {"skepticismLevel":"low","burdenSensitivity":"low"}')
    expect(text).toContain('Profiles cannot expand source purposes, supply facts or change the burden.')
  })
  it.each([[0, 30, 'low', 'low'], [31, 69, 'moderate', 'moderate'], [70, 100, 'high', 'high'], [-1, 101, 'invalid', 'invalid']])('labels boundary values %s and %s', async (skepticismLevel, burdenSensitivity, skepticism, burden) => {
    const request = structuredClone(capture.request)
    Object.assign(request.jurorProfiles[0], { skepticismLevel, burdenSensitivity })
    const text = await checkerContext(request)
    expect(text).toContain(JSON.stringify({ skepticismLevel: skepticism, burdenSensitivity: burden }))
  })
  it('leaves a missing current profile null and does not substitute a peer', async () => {
    const request = structuredClone(capture.request)
    request.jurorProfiles[0].juror = 'peer'
    request.jurorProfiles[0].bias = 'PRIVATE_PEER_SENTINEL'
    const text = await checkerContext(request)
    expect(text).toContain('assessment traits, not evidence): null')
    expect(text).not.toContain('PRIVATE_PEER_SENTINEL')
    expect(text).not.toContain('"skepticismLevel":"low"')
  })
  it('does not expose bands in a witness task', async () => {
    const text = await checkerContext({ ...capture.request, stage: 'witness_answer', courtroomActor: { id: 'w1', roles: ['witness'] } })
    expect(text).not.toContain('"skepticismLevel":"low"')
  })
})
