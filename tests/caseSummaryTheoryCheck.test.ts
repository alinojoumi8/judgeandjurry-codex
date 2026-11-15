import request from 'supertest'
import { afterEach, describe, expect, it } from 'vitest'

import { AnalysisJobService } from '../server/analysis/jobs'
import type { CaseSummaryContent } from '../server/analysis/caseSummary'
import { StructuredModelError, type StructuredRequest } from '../server/analysis/structured'
import { createApp } from '../server/app'
import type { ModelClient } from '../server/minimax'
import { cleanupAnalysisFixtures } from './analysisFixtures'
import { summaryRouter, summaryWorld, type ReplySentence, type SummaryRouterOptions } from './caseSummaryFixtures'
import { checkerRouter, clientFor, isCheck, statementsOf, type Decide } from './modelCheckFixtures'

afterEach(cleanupAnalysisFixtures)

class UnusedModel implements ModelClient {
  async generateStage(): Promise<never> { throw new Error('No simulation model call is expected here.') }
}

// Theory sentences with known verdicts. Only the first five fit the first checker batch, so the sixth is in the batch that fails.
const theoryTexts = {
  one: 'THEORY-ONE: Jordan Ellery says the walkway was left in an unsafe state.',
  unsure: 'THEORY-UNSURE: Jordan Ellery says the crew leader was the only person on shift.',
  three: 'THEORY-THREE: Jordan Ellery says no salt was visible at the east entrance.',
  four: 'THEORY-FOUR: Jordan Ellery says the glare ice was there when the guard looked.',
  five: 'THEORY-FIVE: Jordan Ellery says the fall happened at the east entrance.',
  failed: 'THEORY-FAILED: Jordan Ellery says nobody salted the walkway that morning.',
}
const decide: Decide = (statement) => (statement.includes('THEORY-UNSURE') ? { verdict: 'cannot_tell', reason: 'The passage is too short to tell.' } : 'supported')
const audit = { task: 'artifact_model_check', promptVersion: 'model-check-v1', provider: 'scripted', model: 'scripted', mode: 'scripted' as const, attempts: 1 }

// The summary the scripted model writes: the given theory sentences (each citing a real passage), then the faithful sections.
function withTheory(texts: string[]): SummaryRouterOptions {
  return { sentences: (_party, faithful) => [...texts.map((text): ReplySentence => ({ section: 'theory', text, sources: faithful[0].sources })), ...faithful.filter((sentence) => sentence.section !== 'theory')] }
}
const mixed = withTheory(Object.values(theoryTexts))

function checkedRouter(options: SummaryRouterOptions, check: Decide = decide) {
  const answer = checkerRouter(check, summaryRouter(options))
  return (request: StructuredRequest<unknown>): unknown => {
    // The batch that holds the sixth theory sentence fails, so that sentence is kept and left unchecked.
    if (isCheck(request) && statementsOf(request).some((entry) => entry.statement.includes('THEORY-FAILED'))) throw new StructuredModelError('The provider timed out.', { category: 'timeout', audit })
    return answer(request)
  }
}

async function worldWith(options: SummaryRouterOptions, modelCheck: boolean, check?: Decide) {
  const world = await summaryWorld()
  await world.summaries.generate(world.matterId, { client: clientFor(checkedRouter(options, check)), modelCheck })
  world.summaries.approve(world.matterId, 'ellery')
  return world
}

const briefsJson = (world: Awaited<ReturnType<typeof summaryWorld>>) => JSON.stringify(world.workflow.listCaseModels(world.matterId).map((model) => [model.id, world.store.workflow.listTheoryBriefs(model.id)]))
// What "use as theory" wrote before the model check existed, written out independently of the code under test.
const legacyNarrative = (world: Awaited<ReturnType<typeof summaryWorld>>) => {
  const view = world.summaries.view(world.matterId, 'ellery').approved!
  const lines = view.sections.find((section) => section.key === 'theory')!.sentences.map((item) => `${item.text} [${item.citations.map((citation) => `${citation.exhibitId} para. ${citation.paragraph}`).join('; ')}]`)
  return ['Theory of the case, from a model-generated summary (version 1) whose citations were checked against the preserved source:', ...lines].join('\n')
}

describe('case summaries: use as theory with the model check', () => {
  it('carries every theory sentence, unchanged, when the check confirmed them all', async () => {
    const world = await worldWith(withTheory([theoryTexts.one, theoryTexts.three]), true)
    const preview = world.summaries.useAsTheoryPreview(world.matterId, 'ellery')
    expect(preview.newNarrative).toBe(legacyNarrative(world))
    expect(preview.newNarrative).not.toMatch(/not confirmed|not checked/)
    expect(preview.modelCheck).toMatchObject({ includeUnconfirmed: false, theorySentences: 2, carried: 2, notConfirmed: 0, notChecked: 0, leftOut: 0, leftOutSentences: [], includedUnconfirmedIds: [], canUse: true })
    expect(preview.modelCheck!.message).toBe('The model check confirmed all 2 theory-of-the-case sentences.')
    const used = world.summaries.useAsTheory(world.matterId, 'ellery')
    expect(used.brief.narrative).toBe(preview.newNarrative)
    expect(used.modelCheck).toMatchObject({ leftOut: 0, carried: 2 })
  })

  it('carries only the confirmed sentences from a mix, says how many were left out and why, and changes nothing until confirmed', async () => {
    const world = await worldWith(mixed, true)
    const items = world.summaries.view(world.matterId, 'ellery').approved!.content.items.filter((item) => item.section === 'theory')
    // Control: the draft really holds one sentence of each verdict, so the filter is what is being tested.
    expect(items.map((item) => item.modelCheck?.verdict)).toEqual(['supported', 'cannot_tell', 'supported', 'supported', 'supported', 'unchecked'])

    const before = briefsJson(world)
    const preview = world.summaries.useAsTheoryPreview(world.matterId, 'ellery')
    expect(briefsJson(world)).toBe(before)
    expect(world.workflow.listCaseModels(world.matterId)).toHaveLength(1)

    expect(preview.newNarrative).toContain(theoryTexts.one)
    expect(preview.newNarrative).toContain(theoryTexts.three)
    expect(preview.newNarrative).toContain(theoryTexts.four)
    expect(preview.newNarrative).toContain(theoryTexts.five)
    expect(preview.newNarrative).not.toContain('THEORY-UNSURE')
    expect(preview.newNarrative).not.toContain('THEORY-FAILED')
    expect(preview.newNarrative).not.toMatch(/\[not (confirmed|checked) by model check\]/)
    expect(preview.modelCheck).toMatchObject({ includeUnconfirmed: false, theorySentences: 6, carried: 4, notConfirmed: 1, notChecked: 1, leftOut: 2, includedUnconfirmedIds: [], canUse: true })
    expect(preview.modelCheck!.leftOutSentences).toEqual([
      { id: items[1].id, text: theoryTexts.unsure, verdict: 'cannot_tell', label: 'Not confirmed by model check' },
      { id: items[5].id, text: theoryTexts.failed, verdict: 'unchecked', label: 'Not checked' },
    ])
    expect(preview.modelCheck!.message).toBe(
      '2 of 6 theory-of-the-case sentences are left out because the model check did not confirm them (1 not confirmed by the model check, 1 not checked). '
      + 'Only the 4 the check confirmed are carried into the theory. Tick "Also include sentences the model check did not confirm" to carry the others as well; they are then tagged in the text.',
    )

    const used = world.summaries.useAsTheory(world.matterId, 'ellery')
    expect(used.brief.narrative).toBe(preview.newNarrative)
    expect(used.modelCheck).toMatchObject({ leftOut: 2, carried: 4 })
    // The provenance record on the summary says what was carried and that nothing unconfirmed was included.
    const record = world.summaries.view(world.matterId, 'ellery').approved!.content.usedAsTheory!
    expect(record.modelCheck).toEqual({ includeUnconfirmed: false, carried: 4, notConfirmed: 1, notChecked: 1, leftOut: 2, includedUnconfirmedIds: [] })
  })

  it('includes the sentences the check did not confirm only on an explicit opt-in, and keeps them visibly tagged in the text and the provenance', async () => {
    const world = await worldWith(mixed, true)
    const items = world.summaries.view(world.matterId, 'ellery').approved!.content.items.filter((item) => item.section === 'theory')
    const preview = world.summaries.useAsTheoryPreview(world.matterId, 'ellery', { includeUnconfirmed: true })
    const lines = preview.newNarrative.split('\n')
    expect(lines[1]).toBe('Sentences tagged "[not confirmed by model check]" or "[not checked by model check]" were not confirmed by the model check. They are included because the user chose to include them.')
    // Order is the summary's own order. Only the unconfirmed ones carry a tag.
    expect(lines.slice(2)).toEqual([
      `${theoryTexts.one} [E-005 para. 1]`,
      `${theoryTexts.unsure} [E-005 para. 1] [not confirmed by model check]`,
      `${theoryTexts.three} [E-005 para. 1]`,
      `${theoryTexts.four} [E-005 para. 1]`,
      `${theoryTexts.five} [E-005 para. 1]`,
      `${theoryTexts.failed} [E-005 para. 1] [not checked by model check]`,
    ])
    expect(preview.modelCheck).toMatchObject({ includeUnconfirmed: true, carried: 4, leftOut: 0, leftOutSentences: [], includedUnconfirmedIds: [items[1].id, items[5].id], canUse: true })
    expect(preview.modelCheck!.message).toMatch(/^2 theory-of-the-case sentences the model check did not confirm are included because you chose to/)

    const used = world.summaries.useAsTheory(world.matterId, 'ellery', { includeUnconfirmed: true })
    expect(used.brief.narrative).toBe(preview.newNarrative)
    const saved = world.store.workflow.listTheoryBriefs(used.caseModel.id).find((brief) => brief.partyId === 'ellery')!
    expect(saved.narrative).toContain(`${theoryTexts.unsure} [E-005 para. 1] [not confirmed by model check]`)
    const record = world.summaries.view(world.matterId, 'ellery').approved!.content.usedAsTheory!
    expect(record.modelCheck).toEqual({ includeUnconfirmed: true, carried: 4, notConfirmed: 1, notChecked: 1, leftOut: 0, includedUnconfirmedIds: [items[1].id, items[5].id] })
    // An explicit false is the default.
    const again = await worldWith(mixed, true)
    expect(again.summaries.useAsTheoryPreview(again.matterId, 'ellery', { includeUnconfirmed: false }).newNarrative).not.toContain('THEORY-UNSURE')
  })

  it('has nothing to carry when the check confirmed no theory sentence, until the user opts in', async () => {
    const world = await worldWith(withTheory([theoryTexts.unsure]), true)
    const preview = world.summaries.useAsTheoryPreview(world.matterId, 'ellery')
    expect(preview.newNarrative).toBe('')
    expect(preview.modelCheck).toMatchObject({ carried: 0, leftOut: 1, canUse: false })
    expect(() => world.summaries.useAsTheory(world.matterId, 'ellery')).toThrow(/confirmed none of this summary's theory-of-the-case sentences/)
    expect(world.workflow.listCaseModels(world.matterId)).toHaveLength(1)
    const opted = world.summaries.useAsTheory(world.matterId, 'ellery', { includeUnconfirmed: true })
    expect(opted.brief.narrative).toContain(`${theoryTexts.unsure} [E-005 para. 1] [not confirmed by model check]`)
    expect(opted.caseModel).toMatchObject({ version: 2, status: 'draft' })
  })

  it('is byte-identical to the earlier behaviour when no model check was requested, whatever the option says', async () => {
    const plain = await worldWith(mixed, false)
    const content = plain.summaries.view(plain.matterId, 'ellery').approved!.content as CaseSummaryContent
    expect('modelCheck' in content).toBe(false)
    const before = briefsJson(plain)
    const preview = plain.summaries.useAsTheoryPreview(plain.matterId, 'ellery')
    expect(briefsJson(plain)).toBe(before)
    expect(preview.newNarrative).toBe(legacyNarrative(plain))
    // Every sentence is carried, including the ones a check would have flagged, and nothing is tagged.
    expect(preview.newNarrative).toContain('THEORY-UNSURE')
    expect(preview.newNarrative).toContain('THEORY-FAILED')
    expect(preview.newNarrative).not.toMatch(/model check/)
    expect('modelCheck' in preview).toBe(false)
    expect(Object.keys(preview).sort()).toEqual(['base', 'newNarrative', 'newTitle', 'nextVersion', 'notes', 'party', 'replaces', 'summary'])
    // The opt-in does nothing here.
    expect(plain.summaries.useAsTheoryPreview(plain.matterId, 'ellery', { includeUnconfirmed: true })).toEqual(preview)
    const used = plain.summaries.useAsTheory(plain.matterId, 'ellery', { includeUnconfirmed: true })
    expect(Object.keys(used).sort()).toEqual(['artifactId', 'brief', 'caseModel', 'replacedBriefId'])
    expect(used.brief.narrative).toBe(preview.newNarrative)
    expect('modelCheck' in plain.summaries.view(plain.matterId, 'ellery').approved!.content.usedAsTheory!).toBe(false)

    // A summary the check confirmed in full gives the same text a summary made without the check does.
    const all = withTheory([theoryTexts.one, theoryTexts.three])
    const checked = await worldWith(all, true)
    const unchecked = await worldWith(all, false)
    expect(checked.summaries.useAsTheoryPreview(checked.matterId, 'ellery').newNarrative).toBe(unchecked.summaries.useAsTheoryPreview(unchecked.matterId, 'ellery').newNarrative)
  })
})

describe('case summaries: use as theory through the API with the model check', () => {
  const limits = { tokensPerCall: 100, defaultMaxCalls: 10, absoluteMaxCalls: 50, maxConcurrentJobs: 2 }

  async function appWorld(modelCheck: boolean) {
    const world = await summaryWorld()
    const jobs = new AnalysisJobService(world.store, limits)
    const app = createApp({ store: world.store, trialForgeModelClient: new UnusedModel(), analysisJobs: jobs, structuredModelClient: clientFor(checkedRouter(mixed)) })
    const base = `/api/matters/${world.matterId}/case-summary`
    const body = modelCheck ? { modelCheck: true } : {}
    const preview = (await request(app).post(`${base}/generate/preview`).send(body).expect(200)).body
    await request(app).post(`${base}/generate`).send({ ...body, estimateHash: preview.estimate.hash }).expect(202)
    await jobs.whenIdle()
    await request(app).post(`${base}/ellery/approve`).send({}).expect(200)
    return { ...world, app, base }
  }

  it('shows the counts in the preview before confirmation, changes nothing until confirmed, and carries only confirmed sentences by default', async () => {
    const { app, base, matterId, workflow } = await appWorld(true)
    const preview = (await request(app).get(`${base}/ellery/use-as-theory`).expect(200)).body
    expect(preview.modelCheck).toMatchObject({ includeUnconfirmed: false, theorySentences: 6, carried: 4, notConfirmed: 1, notChecked: 1, leftOut: 2, canUse: true })
    expect(preview.modelCheck.message).toMatch(/^2 of 6 theory-of-the-case sentences are left out because the model check did not confirm them/)
    expect(preview.newNarrative).not.toContain('THEORY-UNSURE')
    expect(workflow.listCaseModels(matterId)).toHaveLength(1)

    // The explicit opt-in is a query flag on the preview and a boolean in the confirmation; anything else is refused.
    const opted = (await request(app).get(`${base}/ellery/use-as-theory?includeUnconfirmed=true`).expect(200)).body
    expect(opted.modelCheck).toMatchObject({ includeUnconfirmed: true, leftOut: 0 })
    expect(opted.newNarrative).toContain('[not confirmed by model check]')
    expect((await request(app).get(`${base}/ellery/use-as-theory?includeUnconfirmed=false`).expect(200)).body.newNarrative).toBe(preview.newNarrative)
    await request(app).get(`${base}/ellery/use-as-theory?includeUnconfirmed=yes`).expect(400)
    await request(app).get(`${base}/ellery/use-as-theory?other=1`).expect(400)
    for (const bad of ['true', 'yes', 1, 0, null, {}]) {
      await request(app).post(`${base}/ellery/use-as-theory`).send({ confirm: true, includeUnconfirmed: bad }).expect(400)
    }
    await request(app).post(`${base}/ellery/use-as-theory`).send({ includeUnconfirmed: true }).expect(400)
    expect(workflow.listCaseModels(matterId)).toHaveLength(1)

    const used = (await request(app).post(`${base}/ellery/use-as-theory`).send({ confirm: true }).expect(201)).body
    expect(used.brief.narrative).toBe(preview.newNarrative)
    expect(used.modelCheck).toMatchObject({ leftOut: 2 })
    expect(workflow.listCaseModels(matterId)).toHaveLength(2)
  })

  it('carries the tagged sentences when the confirmation opts in', async () => {
    const { app, base } = await appWorld(true)
    const used = (await request(app).post(`${base}/ellery/use-as-theory`).send({ confirm: true, includeUnconfirmed: true }).expect(201)).body
    expect(used.brief.narrative).toContain(`${theoryTexts.unsure} [E-005 para. 1] [not confirmed by model check]`)
    expect(used.brief.narrative).toContain(`${theoryTexts.failed} [E-005 para. 1] [not checked by model check]`)
    expect(used.modelCheck).toMatchObject({ includeUnconfirmed: true, leftOut: 0 })
  })

  it('leaves the preview and the result exactly as before for a summary made without the check', async () => {
    const { app, base } = await appWorld(false)
    const preview = (await request(app).get(`${base}/ellery/use-as-theory`).expect(200)).body
    expect(Object.keys(preview).sort()).toEqual(['base', 'newNarrative', 'newTitle', 'nextVersion', 'notes', 'party', 'replaces', 'summary'])
    expect(preview.newNarrative).toContain('THEORY-UNSURE')
    await request(app).post(`${base}/ellery/use-as-theory`).send({ confirm: true, includeUnconfirmed: 'yes' }).expect(400)
    const used = (await request(app).post(`${base}/ellery/use-as-theory`).send({ confirm: true }).expect(201)).body
    expect(Object.keys(used).sort()).toEqual(['artifactId', 'brief', 'caseModel', 'replacedBriefId'])
  })
})
