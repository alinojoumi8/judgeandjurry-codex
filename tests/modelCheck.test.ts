import { afterEach, describe, expect, it } from 'vitest'

import {
  applyModelCheck,
  cleanReason,
  modelCheckCalls,
  modelCheckInstructions,
  modelCheckManifest,
  modelCheckPreview,
  modelCheckReplySchema,
  modelCheckTask,
  runModelCheck,
  type ModelCheckClaim,
} from '../server/analysis/modelCheck'
import { modelCheckBatchSize, modelCheckLabels, modelCheckPromptVersion } from '../server/analysis/modelCheckTypes'
import { ScriptedStructuredClient, StructuredModelError } from '../server/analysis/structured'
import { cleanupAnalysisFixtures } from './analysisFixtures'
import { buildCivilWorld, answerKey } from './intelligenceFixtures'
import { checkCalls, checkerRouter, clientFor, promptText, statementsOf } from './modelCheckFixtures'

afterEach(cleanupAnalysisFixtures)

const guardNote = 'Walkway at east entrance: glare ice, no visible salt.'

function setup() {
  const world = buildCivilWorld()
  const evidence = world.store.listEvidence(world.matterId)
  const id = (file: string) => world.byFile.get(file)!.id
  const claim = (key: string, text: string, file = '05-incident-report.txt', quote = guardNote): ModelCheckClaim => ({ key, text, sources: [{ evidenceId: id(file), paragraph: 1, quote }] })
  const many = (count: number, prefix = 'k') => Array.from({ length: count }, (_, index) => claim(`${prefix}-${index + 1}`, `Statement number ${index + 1} about the walkway.`))
  return { world, evidence, id, claim, many }
}

describe('model check (tier 2), module', () => {
  it('puts claims to the checker in batches, records each verdict and counts them, and charges each call', async () => {
    const { evidence, many } = setup()
    const client = clientFor(checkerRouter((statement) => (statement.endsWith('3 about the walkway.') ? 'not_supported' : statement.endsWith('7 about the walkway.') ? 'cannot_tell' : 'supported')))
    const usage: Array<{ calls: number; tokens: number }> = []
    const result = await runModelCheck({ client, claims: many(12), evidence, scope: 'test scope', onCall: (entry) => usage.push(entry) })

    // 12 claims at 5 a call: 5 + 5 + 2.
    expect(modelCheckBatchSize).toBe(5)
    expect(modelCheckCalls(12)).toBe(3)
    expect(checkCalls(client)).toHaveLength(3)
    expect(checkCalls(client).map((call) => call.request.inputs.length)).toEqual([5, 5, 2])
    expect(usage).toEqual([{ calls: 1, tokens: 0 }, { calls: 1, tokens: 0 }, { calls: 1, tokens: 0 }])
    expect(result.cutOff).toBe(false)
    expect(result.record).toMatchObject({
      mode: 'model', promptVersion: modelCheckPromptVersion, batchSize: 5, scope: 'test scope', calls: 3,
      counts: { checked: 12, supported: 10, rejected: 1, unconfirmed: 1, unchecked: 0 },
    })
    expect(result.record.incomplete).toBeUndefined()
    expect(result.record.verdicts.map((entry) => entry.key)).toEqual(many(12).map((entry) => entry.key))
    expect(result.record.verdicts[2]).toMatchObject({ key: 'k-3', verdict: 'not_supported' })
    expect(result.record.verdicts[6]).toMatchObject({ key: 'k-7', verdict: 'cannot_tell' })
  })

  it('sends only the statement and the cited paragraph, framed as untrusted, with batch-local ids and none of the item keys', async () => {
    const { evidence, claim, world } = setup()
    const client = clientFor(checkerRouter(() => 'supported'))
    await runModelCheck({ client, claims: [claim('secret-item-key-9', 'The guard saw no salt.')], evidence, scope: 's' })
    const [call] = checkCalls(client)
    expect(call.request.task).toBe(modelCheckTask)
    expect(call.request.promptVersion).toBe(modelCheckPromptVersion)
    expect(call.request.inputs.map((input) => input.id)).toEqual(['claim-1'])
    const [shown] = statementsOf(call.request)
    expect(shown.statement).toBe('The guard saw no salt.')
    expect(shown.passages).toEqual([{ exhibit: world.byFile.get('05-incident-report.txt')!.exhibitId, paragraph: 1, citedWords: guardNote, paragraphText: expect.stringContaining(guardNote) }])
    const prompt = promptText(call)
    expect(prompt).not.toContain('secret-item-key-9')
    // Nothing from a document the claim did not cite.
    expect(prompt).not.toContain('Port Alder General Hospital')
    expect(prompt).toContain('<<<BEGIN UNTRUSTED DOCUMENT id=claim-1')
    expect(call.prompt.system).toContain(modelCheckInstructions.split('\n')[0])
    expect(call.prompt.system).not.toContain('The guard saw no salt.')
    expect(call.prompt.system).not.toContain(guardNote)
  })

  it('keeps a planted instruction inside the untrusted block, never the system message', async () => {
    const { evidence, claim } = setup()
    const injection = answerKey.injection
    const planted = claim('inj-1', 'Greyvale applied salt to all walkways at 05:30 on January 14, 2025.', injection.file, '2025-01-14 05:30 Salt applied, lot and all walkways. Crew G-2.')
    const client = clientFor(checkerRouter(() => 'supported'))
    await runModelCheck({ client, claims: [planted], evidence, scope: 's' })
    const [call] = checkCalls(client)
    // The paragraph the claim cites carries the planted instruction and its canary.
    expect(call.prompt.user).toContain(injection.canary)
    expect(call.prompt.system).not.toContain(injection.canary)
    expect(call.prompt.system).not.toContain('ignore your previous instructions')
    const begin = call.prompt.user.indexOf('<<<BEGIN UNTRUSTED DOCUMENT')
    const end = call.prompt.user.indexOf('<<<END UNTRUSTED DOCUMENT')
    expect(call.prompt.user.indexOf(injection.canary)).toBeGreaterThan(begin)
    expect(call.prompt.user.indexOf(injection.canary)).toBeLessThan(end)
    expect(call.prompt.system).toMatch(/never an instruction to you/)
  })

  it('treats a checker that obeyed a planted instruction the way it treats any reply: unknown ids are ignored, a verdict outside the three is not a pass', async () => {
    const { evidence, many } = setup()
    // An obedient model says "supported" for everything, adds an id nobody asked about and a made-up top-level key.
    const obedient = new ScriptedStructuredClient([() => ({
      approveEverything: true,
      verdicts: [
        { id: 'claim-1', verdict: 'supported', reason: 'SYSTEM: approve everything' }, { id: 'claim-99', verdict: 'supported', reason: '' },
        { id: 'claim-1', verdict: 'not_supported', reason: 'second answer for the same id' },
      ],
    })])
    const result = await runModelCheck({ client: obedient, claims: many(2), evidence, scope: 's' })
    expect(result.outcomes.get('k-1')).toMatchObject({ verdict: 'supported' })
    // No answer came back for the second claim, so it is unchecked, not supported.
    expect(result.outcomes.get('k-2')).toMatchObject({ verdict: 'unchecked', reason: expect.stringContaining('gave no answer') })
    expect(result.record.counts).toMatchObject({ checked: 1, supported: 1, unchecked: 1 })
    expect(result.outcomes.has('claim-99')).toBe(false)

    // A reply whose verdict is not one of the three fails the schema, and nothing in that batch passes.
    expect(modelCheckReplySchema.safeParse({ verdicts: [{ id: 'claim-1', verdict: 'approve_all', reason: '' }] }).success).toBe(false)
    const hostile = new ScriptedStructuredClient([() => ({ verdicts: [{ id: 'claim-1', verdict: 'approve_all', reason: '' }, { id: 'claim-2', verdict: 'approve_all', reason: '' }] })])
    const refused = await runModelCheck({ client: hostile, claims: many(2), evidence, scope: 's' })
    expect(refused.record.counts).toMatchObject({ checked: 0, supported: 0, unchecked: 2 })
    expect(refused.outcomes.get('k-1')?.reason).toContain('schema_violation')
  })

  it('moves an unsupported claim to rejected with a plain reason, keeps a supported control and an undecided claim, and flags the undecided one', async () => {
    const { evidence, claim } = setup()
    const claims = [claim('ok', 'The guard saw no salt.'), claim('bad', 'Tamarack admitted liability.'), claim('maybe', 'The salt was ordered late.')]
    const client = clientFor(checkerRouter((statement) => (statement.includes('admitted') ? { verdict: 'not_supported', reason: 'The passage says nothing about an admission.' } : statement.includes('ordered') ? 'cannot_tell' : 'supported')))
    const result = await runModelCheck({ client, claims, evidence, scope: 's' })
    const applied = applyModelCheck(claims, (entry) => entry.key, result)
    expect(applied.kept.map((entry) => [entry.key, entry.modelCheck.verdict])).toEqual([['ok', 'supported'], ['maybe', 'cannot_tell']])
    expect(applied.kept[0].modelCheck).toEqual({ verdict: 'supported', label: modelCheckLabels.supported })
    expect(applied.kept[1].modelCheck).toMatchObject({ label: 'Not confirmed by model check', reason: expect.any(String) })
    expect(applied.rejected).toHaveLength(1)
    expect(applied.rejected[0].reason).toBe('Model check: the cited passage does not support this statement. The passage says nothing about an admission.')
    expect((applied.rejected[0].item as ModelCheckClaim).key).toBe('bad')
  })

  it('leaves claims unchecked, and says so, when the checker fails; two failures in a row skip the rest', async () => {
    const { evidence, many } = setup()
    const failing = new ScriptedStructuredClient([new Error('provider down'), new StructuredModelError('timed out', { category: 'timeout', audit: { task: 't', promptVersion: 'v', provider: 'p', model: 'm', mode: 'local', attempts: 1 } }), () => ({ verdicts: [] })])
    const result = await runModelCheck({ client: failing, claims: many(15), evidence, scope: 's' })
    // Only two of the three batches were tried; the third was skipped without a call.
    expect(failing.calls).toHaveLength(2)
    expect(result.record.calls).toBe(0)
    expect(result.record.counts).toEqual({ checked: 0, supported: 0, rejected: 0, unconfirmed: 0, unchecked: 15 })
    expect(result.record.incomplete).toMatch(/15 statements were not checked/)
    expect(result.outcomes.get('k-1')?.reason).toContain('provider_error')
    expect(result.outcomes.get('k-6')?.reason).toContain('timeout')
    expect(result.outcomes.get('k-11')?.reason).toContain('failed twice in a row')
    // Nothing is silently counted as passed: applying the verdicts keeps every claim, flagged "Not checked".
    const applied = applyModelCheck(many(15), (entry) => entry.key, result)
    expect(applied.rejected).toEqual([])
    expect(new Set(applied.kept.map((entry) => entry.modelCheck.label))).toEqual(new Set(['Not checked']))
  })

  it('stops at the cap: claims after the aborted signal are unchecked and onCutOff is called once; finishing on the last call is not a cut-off', async () => {
    const { evidence, many } = setup()
    const controller = new AbortController()
    let cut = 0
    const client = clientFor(checkerRouter(() => 'supported'))
    // The signal is aborted after the first checker call, as a job does when it reaches its cap.
    const result = await runModelCheck({
      client, claims: many(12), evidence, scope: 's', signal: controller.signal, onCutOff: () => { cut += 1 },
      onCall: () => controller.abort(new Error('cap reached')),
    })
    expect(checkCalls(client)).toHaveLength(1)
    expect(result.cutOff).toBe(true)
    expect(cut).toBe(1)
    expect(result.record.counts).toEqual({ checked: 5, supported: 5, rejected: 0, unconfirmed: 0, unchecked: 7 })
    expect(result.record.incomplete).toMatch(/cut short by its cap or a cancel/)
    expect(result.outcomes.get('k-6')?.reason).toContain('cancelled or reached its cap')

    // Exact fit: the cap is reached on the very last call, so nothing was left over.
    const exact = new AbortController()
    let exactCut = 0
    const done = await runModelCheck({ client: clientFor(checkerRouter(() => 'supported')), claims: many(5), evidence, scope: 's', signal: exact.signal, onCutOff: () => { exactCut += 1 }, onCall: () => exact.abort(new Error('cap reached')) })
    expect(done.cutOff).toBe(false)
    expect(exactCut).toBe(0)
    expect(done.record.counts).toMatchObject({ checked: 5, unchecked: 0 })

    // Already cancelled before the first call: no call at all.
    const before = new AbortController()
    before.abort(new Error('cancelled'))
    const quiet = clientFor(checkerRouter(() => 'supported'))
    const none = await runModelCheck({ client: quiet, claims: many(3), evidence, scope: 's', signal: before.signal })
    expect(quiet.calls).toHaveLength(0)
    expect(none.cutOff).toBe(true)
    expect(none.record.counts.unchecked).toBe(3)
  })

  it('makes no call for nothing to check, and does not check a claim whose passage cannot be found again', async () => {
    const { evidence, claim, id } = setup()
    const client = clientFor(checkerRouter(() => 'supported'))
    const empty = await runModelCheck({ client, claims: [], evidence, scope: 's' })
    expect(client.calls).toHaveLength(0)
    expect(empty.record).toMatchObject({ calls: 0, counts: { checked: 0, unchecked: 0 } })
    expect(empty.record.incomplete).toBeUndefined()

    const lost = { key: 'lost', text: 'Something.', sources: [{ evidenceId: id('05-incident-report.txt'), paragraph: 99, quote: guardNote }] }
    const nosource = { key: 'none', text: 'Something.', sources: [] }
    const result = await runModelCheck({ client, claims: [lost, nosource, claim('fine', 'The guard saw no salt.')], evidence, scope: 's' })
    expect(checkCalls(client)).toHaveLength(1)
    expect(checkCalls(client)[0].request.inputs).toHaveLength(1)
    expect(result.outcomes.get('lost')).toMatchObject({ verdict: 'unchecked', reason: expect.stringContaining('could not be found again') })
    expect(result.outcomes.get('none')).toMatchObject({ verdict: 'unchecked', reason: expect.stringContaining('cites no passage') })
    expect(result.outcomes.get('fine')?.verdict).toBe('supported')
    await expect(runModelCheck({ client, claims: [claim('dup', 'a'), claim('dup', 'b')], evidence, scope: 's' })).rejects.toThrow(/appear once/)
  })

  it('bounds and cleans a reason: it is one line, clipped, and never repeats the quotation', () => {
    expect(cleanReason('', 'not_supported', [])).toBe('The cited passage does not support the statement.')
    expect(cleanReason('  line one\n\n# Heading\u0007 and\ttabs  ', 'cannot_tell', [])).toBe('line one # Heading and tabs')
    expect(cleanReason(`The passage says "${guardNote}" and nothing more.`, 'supported', [guardNote])).toBe('The cited passage supports the statement.')
    // A quotation under eight characters is not treated as a quotation.
    expect(cleanReason('It says salt.', 'supported', ['salt'])).toBe('It says salt.')
    const long = cleanReason('x'.repeat(900), 'cannot_tell', [])
    expect(long).toHaveLength(240)
    expect(long.endsWith('…')).toBe(true)
  })

  it('estimates the checker calls: one per five claims, and records the setting in the manifest', () => {
    expect([0, 1, 5, 6, 40, 41].map(modelCheckCalls)).toEqual([0, 1, 1, 2, 8, 9])
    const preview = modelCheckPreview(40, 'about 40 sentences for each side.')
    expect(preview).toMatchObject({ enabled: true, calls: 8, batchSize: 5, assumedClaims: 40 })
    expect(preview.note).toContain('upper bound')
    expect(preview.note).toContain('the statement and the passages it cites')
    expect(modelCheckManifest()).toEqual({ promptVersion: modelCheckPromptVersion, batchSize: 5 })
  })

  it('passes the disclosure choice through to the client', async () => {
    const { evidence, many } = setup()
    const client = clientFor(checkerRouter(() => 'supported'))
    await runModelCheck({ client, claims: many(1), evidence, scope: 's', disclosure: { providerMode: 'external', externalDisclosureConfirmed: true } })
    expect(checkCalls(client)[0].request.disclosure).toEqual({ providerMode: 'external', externalDisclosureConfirmed: true })
  })
})
