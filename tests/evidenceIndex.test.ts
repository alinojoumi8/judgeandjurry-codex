import { afterEach, describe, expect, it } from 'vitest'

import {
  countsAsEvidence,
  detectRecordGaps,
  entryTypes,
  EvidenceIndexService,
  evidenceAssertions,
  indexAssertions,
  type CoverageView,
  type EvidenceIndexContent,
} from '../server/analysis/evidenceIndex'
import { checkPassage } from '../server/analysis/sourceCheck'
import { addSource, cleanupAnalysisFixtures } from './analysisFixtures'
import { answerKey, buildCivilWorld, civilFiles, civilText, documentOf, routedClient, type CivilWorld, type Router } from './intelligenceFixtures'

afterEach(cleanupAnalysisFixtures)

// What a faithful model would return, per document, for the fixture. Three
// replies are deliberately flawed, to show what the code refuses.
function indexRouter(world: CivilWorld, options: { flawed?: boolean } = { flawed: true }): Router {
  const byExhibit = new Map([...world.byFile].map(([file, item]) => [item.exhibitId, file]))
  const src = (file: string, quote: string) => ({ evidenceId: world.exhibit(file), paragraph: 1, quote })
  return (request) => {
    if (request.task !== 'evidence_index_extraction') throw new Error(`Unexpected task ${request.task}`)
    const file = byExhibit.get(documentOf(request)!)!
    const reply: { entries: unknown[]; suggestions: unknown[]; gaps: unknown[] } = { entries: [], suggestions: [], gaps: [] }
    if (file === '01-statement-of-claim.txt') {
      const quote = '10. Greyvale was negligent in failing to salt the walkway at the east entrance before the Plaintiff arrived.'
      reply.entries.push({ type: 'allegation', summary: 'Greyvale is alleged to have failed to salt the east walkway.', sources: [src(file, quote)], issueIds: ['issue-greyvale'] })
      reply.suggestions.push({ issueId: 'issue-greyvale', elementId: 'el-salt', stance: 'supporting', evidenceId: world.exhibit(file), paragraph: 1, quote, note: 'Pleaded failure to salt.' })
      if (options.flawed) {
        // A pleading cannot be the source of testimony.
        reply.entries.push({ type: 'testimony', speaker: 'Plaintiff', examinationType: 'direct', summary: 'The Plaintiff says she fell.', sources: [src(file, 'the Plaintiff slipped and fell on ice')], issueIds: [] })
      }
    }
    if (file === '05-incident-report.txt') {
      reply.suggestions.push({ issueId: 'issue-greyvale', elementId: 'el-salt', stance: 'supporting', evidenceId: world.exhibit(file), paragraph: 1, quote: 'Walkway at east entrance: glare ice, no visible salt.', note: 'Guard saw no salt.' })
      if (options.flawed) {
        reply.suggestions.push({ issueId: 'issue-greyvale', elementId: 'el-not-real', stance: 'supporting', evidenceId: world.exhibit(file), paragraph: 1, quote: 'Walkway at east entrance: glare ice, no visible salt.', note: '' })
        // An opinion from a document that is not an expert report.
        reply.entries.push({ type: 'expert_opinion', summary: 'Ice caused the fall.', sources: [src(file, 'Walkway at east entrance: glare ice, no visible salt.')], issueIds: [] })
      }
    }
    if (file === '06-winter-service-log.txt') {
      reply.suggestions.push({ issueId: 'issue-greyvale', elementId: 'el-salt', stance: 'contrary', evidenceId: world.exhibit(file), paragraph: 1, quote: '2025-01-14 05:30 Salt applied, lot and all walkways. Crew G-2.', note: 'Greyvale log.' })
      reply.gaps.push({ description: 'No independent weather record for January 13 and 14, 2025; only the Greyvale log note.', sources: [src(file, 'Weather note: freezing drizzle overnight.')] })
      if (options.flawed) reply.gaps.push({ description: 'A gap with an invented quotation.', sources: [src(file, 'Weather was perfectly dry all night.')] })
    }
    if (file === '15-discovery-excerpt-plaintiff.txt') {
      reply.entries.push({ type: 'testimony', speaker: 'Jordan Ellery', examinationType: 'discovery', summary: 'About 7:40 a.m. is the time of the fall.', sources: [src(file, 'A. About 7:40 in the morning.')], issueIds: ['issue-greyvale'] })
    }
    if (file === '16-discovery-excerpt-greyvale.txt') {
      reply.entries.push({ type: 'admission', speaker: 'Dale Whitlock', examinationType: 'discovery', summary: 'Greyvale cannot explain the GPS gap.', sources: [src(file, 'I cannot explain why the GPS shows no visit before 9:14.')], issueIds: ['issue-greyvale'] })
    }
    for (const expert of answerKey.experts.filter((candidate) => candidate.file === file)) {
      for (const opinion of expert.opinions) {
        reply.entries.push({ type: 'expert_opinion', speaker: expert.name, summary: opinion.summary, sources: [src(file, opinion.quote)], issueIds: ['issue-damages'] })
      }
    }
    return reply
  }
}

async function indexed(options: { flawed?: boolean } = { flawed: true }) {
  const world = buildCivilWorld()
  const client = routedClient(indexRouter(world, options))
  const service = new EvidenceIndexService(world.store, world.service, world.workflow)
  const artifact = await service.generate(world.matterId, { client })
  return { world, client, service, artifact, content: artifact.content as unknown as EvidenceIndexContent }
}

describe('F5 allegations can never be counted as evidence', () => {
  it('has one rule: only record, testimony, admission and expert opinion count, and only on evidence-bearing entry types', () => {
    expect([...evidenceAssertions].sort()).toEqual(['admission', 'expert_opinion', 'record', 'testimony'])
    for (const type of entryTypes) {
      for (const assertion of indexAssertions) {
        const counted = countsAsEvidence({ type, assertion })
        // Table-driven: an allegation or an inference is never counted, for any entry type.
        if (assertion === 'allegation' || assertion === 'inference') expect(counted, `${type}/${assertion}`).toBe(false)
        // Analysis constructs are never evidence either, whatever their assertion.
        if (['disputed_fact', 'theory_claim', 'disclosure_finding'].includes(type)) expect(counted, `${type}/${assertion}`).toBe(false)
      }
    }
    // Valid controls.
    expect(countsAsEvidence({ type: 'passage', assertion: 'record' })).toBe(true)
    expect(countsAsEvidence({ type: 'testimony', assertion: 'testimony' })).toBe(true)
    expect(countsAsEvidence({ type: 'admission', assertion: 'admission' })).toBe(true)
    expect(countsAsEvidence({ type: 'expert_opinion', assertion: 'expert_opinion' })).toBe(true)
  })

  it('flags allegation entries, pleading passages and theory claims as not evidence in the listing', async () => {
    const { world, service } = await indexed()
    const page = service.list(world.matterId, { pageSize: 200 })
    const allegations = page.entries.filter((entry) => entry.assertion === 'allegation')
    expect(allegations.length).toBeGreaterThanOrEqual(4)
    for (const entry of allegations) expect(entry.countsAsEvidence, entry.id).toBe(false)
    // The pleading passages of the fixture are typed allegation from the document role.
    const claim = page.entries.find((entry) => entry.type === 'passage' && entry.sources[0].exhibitId === world.exhibit('01-statement-of-claim.txt'))
    expect(claim).toMatchObject({ assertion: 'allegation', countsAsEvidence: false })
    // Valid control: a medical record passage counts.
    expect(page.entries.find((entry) => entry.type === 'passage' && entry.sources[0].exhibitId === world.exhibit('10-family-physician-chart.txt'))).toMatchObject({ assertion: 'record', countsAsEvidence: true })
    // Filtering for evidence never returns an allegation.
    const evidence = service.list(world.matterId, { countsAsEvidence: true, pageSize: 200 })
    expect(evidence.entries.length).toBeGreaterThan(20)
    expect(evidence.entries.some((entry) => entry.assertion === 'allegation' || entry.assertion === 'inference')).toBe(false)
    expect(page.totals.notEvidence).toBe(page.entries.filter((entry) => !entry.countsAsEvidence).length)
  })

  it('does not count a link to an allegation as support in the coverage view, and counts a record link', async () => {
    const { world, service } = await indexed()
    const claim = service.suggestions(world.matterId).find((suggestion) => suggestion.assertion === 'allegation')!
    expect(claim).toMatchObject({ issueId: 'issue-greyvale', elementId: 'el-salt' })
    service.acceptSuggestion(world.matterId, claim.id)
    const afterAllegation = service.coverage(world.matterId)
    const row = (view: CoverageView) => view.elements.find((element) => element.elementId === 'el-salt')!
    expect(row(afterAllegation)).toMatchObject({ supporting: 0, allegationOnly: 1, noSupport: true })

    const record = service.suggestions(world.matterId).find((suggestion) => suggestion.assertion === 'record' && suggestion.stance === 'supporting')!
    service.acceptSuggestion(world.matterId, record.id)
    expect(row(service.coverage(world.matterId))).toMatchObject({ supporting: 1, allegationOnly: 1, noSupport: false, noContrary: true })

    const contrary = service.suggestions(world.matterId).find((suggestion) => suggestion.stance === 'contrary')!
    service.acceptSuggestion(world.matterId, contrary.id)
    expect(row(service.coverage(world.matterId))).toMatchObject({ supporting: 1, contrary: 1, noContrary: false })
  })

  it('treats a link whose source passage the model typed as an allegation as an allegation even in a non-pleading document', async () => {
    const world = buildCivilWorld()
    const letter = addSource(world.store, world.matterId, '20-demand-letter.txt', 'Letter from counsel.\nThe sender alleges that the walkway was never salted before the fall.')
    const router: Router = (request) => (documentOf(request) === letter.exhibitId
      ? {
        entries: [{ type: 'allegation', summary: 'Counsel alleges no salt.', sources: [{ evidenceId: letter.exhibitId, paragraph: 1, quote: 'The sender alleges that the walkway was never salted before the fall.' }], issueIds: [] }],
        suggestions: [{ issueId: 'issue-greyvale', elementId: 'el-salt', stance: 'supporting', evidenceId: letter.exhibitId, paragraph: 1, quote: 'The sender alleges that the walkway was never salted before the fall.', note: '' }],
      }
      : { entries: [] })
    const service = new EvidenceIndexService(world.store, world.service, world.workflow)
    await service.generate(world.matterId, { client: routedClient(router) })
    service.acceptSuggestion(world.matterId, 'sg-001')
    const row = service.coverage(world.matterId).elements.find((element) => element.elementId === 'el-salt')!
    // The letter's passage is the entry's quotation plus the letter's greeting, so the quoted allegation is inside it.
    expect(row).toMatchObject({ supporting: 0, allegationOnly: 1 })
  })
})

describe('F5 extraction (scripted model)', () => {
  it('types testimony with a speaker and examination type, admissions and expert opinions, and checks every passage', async () => {
    const { world, artifact, content, client } = await indexed()
    expect(artifact).toMatchObject({ kind: 'evidence_index', status: 'draft' })
    expect(client.calls).toHaveLength(19)
    const evidence = world.store.listEvidence(world.matterId)
    for (const entry of content.items) {
      for (const source of entry.sources) expect(checkPassage(source, evidence), entry.id).toBeNull()
    }
    const types = content.items.map((entry) => entry.type)
    expect(types).toEqual(expect.arrayContaining(['allegation', 'testimony', 'admission', 'expert_opinion']))
    const testimony = content.items.find((entry) => entry.type === 'testimony')!
    expect(testimony).toMatchObject({ speaker: 'Jordan Ellery', examinationType: 'discovery' })
    expect(content.items.filter((entry) => entry.type === 'expert_opinion')).toHaveLength(answerKey.experts.flatMap((expert) => expert.opinions).length)
  })

  it('refuses testimony from a pleading, an expert opinion from a non-expert document, an invented quotation and an unknown element', async () => {
    const { artifact, content } = await indexed()
    const reasons = artifact.rejected.map((item) => item.reason).join('\n')
    expect(reasons).toMatch(/pleading records what a party alleges, not testimony/)
    expect(reasons).toMatch(/must come from an expert report/)
    expect(reasons).toMatch(/does not appear in that paragraph/)
    expect(reasons).toMatch(/not part of the case model/)
    expect(artifact.rejected).toHaveLength(4)
    expect(content.items.some((entry) => entry.type === 'testimony' && entry.speaker === 'Plaintiff')).toBe(false)
    // Valid controls: with a faithful model nothing is refused.
    return indexed({ flawed: false }).then(({ artifact: clean }) => expect(clean.rejected).toEqual([]))
  })

  it('keeps the planted injection out of the instructions and out of every output', async () => {
    const { client, content, artifact } = await indexed()
    const { canary, file, line } = answerKey.injection
    for (const call of client.calls) {
      expect(call.prompt.system).not.toContain(canary)
      expect(call.request.instructions).not.toContain(canary)
    }
    const call = client.calls.find((entry) => entry.request.inputs[0].text.includes(line))!
    expect(call.prompt.user).toContain(line)
    expect(JSON.stringify([content, artifact.rejected])).not.toContain(canary)
    expect(file).toBe('06-winter-service-log.txt')
  })

  it('works with no case model: no suggestions are accepted into nothing', async () => {
    const world = buildCivilWorld({ approve: false })
    const service = new EvidenceIndexService(world.store, world.service, world.workflow)
    const artifact = await service.generate(world.matterId, { client: routedClient(indexRouter(world)) })
    expect(artifact.status).toBe('draft')
  })
})

describe('F5 suggestions are proposals: nothing changes until one is accepted', () => {
  it('leaves the case model untouched after generation and after a rejection', async () => {
    const { world, service, artifact } = await indexed()
    const versionsBefore = world.store.workflow.listCaseModels(world.matterId)
    expect(service.suggestions(world.matterId).length).toBeGreaterThanOrEqual(3)
    expect(service.suggestions(world.matterId).every((suggestion) => suggestion.status === 'proposed')).toBe(true)
    expect(world.store.workflow.listCaseModels(world.matterId)).toEqual(versionsBefore)
    expect(world.model.evidenceMatrix ?? []).toEqual([])

    const target = service.suggestions(world.matterId)[0]
    const rejected = service.rejectSuggestion(world.matterId, target.id)
    expect(rejected.status).toBe('rejected')
    expect(world.store.workflow.listCaseModels(world.matterId)).toEqual(versionsBefore)
    const coverage = service.coverage(world.matterId)
    expect(coverage.elements.every((element) => element.supporting === 0 && element.contrary === 0)).toBe(true)
    expect(coverage.noSupport).toHaveLength(coverage.elements.length)
    // The decision made a new draft of the index; the first version is unchanged.
    expect(world.service.get(world.matterId, artifact.id).contentHash).toBe(artifact.contentHash)
    expect(world.service.list(world.matterId, { kind: 'evidence_index' })).toHaveLength(2)
    expect(service.extraction(world.matterId).content.reviewLog).toEqual([{ suggestionId: target.id, action: 'reject' }])
  })

  it('saves an accepted suggestion through the case model matrix as a new version, with the exact passage text', async () => {
    const { world, service } = await indexed()
    const suggestion = service.suggestions(world.matterId).find((candidate) => candidate.assertion === 'record')!
    const before = world.store.workflow.listCaseModels(world.matterId)
    const { caseModel, suggestion: accepted } = service.acceptSuggestion(world.matterId, suggestion.id)
    expect(accepted).toMatchObject({ status: 'accepted', caseModelId: caseModel.id })
    expect(world.store.workflow.listCaseModels(world.matterId)).toHaveLength(before.length + 1)
    expect(caseModel).toMatchObject({ version: world.model.version + 1, status: 'draft' })
    const row = caseModel.evidenceMatrix!.find((candidate) => candidate.issueId === suggestion.issueId && candidate.elementId === suggestion.elementId)!
    const source = world.store.listEvidence(world.matterId).find((item) => item.id === suggestion.passage.evidenceId)!
    expect(row.links).toEqual([{ evidenceId: source.id, paragraph: 1, stance: 'supporting', note: 'Guard saw no salt.', quote: source.text.trimEnd() }])
    // The approved model is untouched.
    expect(world.store.workflow.getCaseModel(world.model.id).evidenceMatrix ?? []).toEqual([])
    // Accepted suggestions cannot be decided again.
    expect(() => service.acceptSuggestion(world.matterId, suggestion.id)).toThrow(/already accepted/)
    expect(() => service.rejectSuggestion(world.matterId, suggestion.id)).toThrow(/already accepted/)
  })

  it('adds to an existing matrix row without duplicating a passage', async () => {
    const { world, service } = await indexed()
    const [first, second] = service.suggestions(world.matterId).filter((candidate) => candidate.issueId === 'issue-greyvale' && candidate.elementId === 'el-salt')
    const one = service.acceptSuggestion(world.matterId, first.id).caseModel
    const two = service.acceptSuggestion(world.matterId, second.id).caseModel
    expect(two.version).toBe(one.version + 1)
    expect(two.evidenceMatrix!.find((row) => row.elementId === 'el-salt')!.links).toHaveLength(2)
    // Mapping to a second element of the same issue keeps the first row.
    expect(two.evidenceMatrix).toHaveLength(1)
  })

  it('refuses an unknown suggestion, an unknown case model and a suggestion for an element the model lacks', async () => {
    const { world, service } = await indexed()
    expect(() => service.acceptSuggestion(world.matterId, 'sg-999')).toThrow(/not found/)
    const suggestion = service.suggestions(world.matterId)[0]
    expect(() => service.acceptSuggestion(world.matterId, suggestion.id, { caseModelId: 'missing' })).toThrow(/does not belong/)
    // A model that dropped the element cannot receive the suggestion.
    const reduced = world.workflow.reviseCaseModel(world.model.id, {
      decisionIssues: world.model.decisionIssues.map((issue) => (issue.id === 'issue-greyvale' ? { ...issue, elements: issue.elements.filter((element) => element.id !== 'el-salt') } : issue)),
    })
    expect(() => service.acceptSuggestion(world.matterId, suggestion.id, { caseModelId: reduced.id })).toThrow(/not part of this case model/)
    expect(world.store.workflow.listCaseModels(world.matterId)).toHaveLength(2)
  })

  it('refuses to decide a suggestion once the evidence has changed', async () => {
    const { world, service } = await indexed()
    addSource(world.store, world.matterId, 'late.txt', 'A late source dated March 3, 2024.')
    expect(() => service.acceptSuggestion(world.matterId, 'sg-001')).toThrow(/out of date/)
    expect(() => service.rejectSuggestion(world.matterId, 'sg-001')).toThrow(/out of date/)
  })

  it('exposes suggestions only as proposals in the approved-artifact path after approval', async () => {
    const { world, service } = await indexed()
    expect(world.service.approvedFor({ role: 'owner' }, world.matterId, 'evidence_index')).toEqual([])
    service.approve(world.matterId)
    expect(world.service.approvedFor({ role: 'owner' }, world.matterId, 'evidence_index')).toHaveLength(1)
    expect(service.list(world.matterId, { type: 'testimony' }).entries[0].provisional).toBe(false)
  })
})

describe('F5 admission status is read from the ledger, never copied', () => {
  it('shows an admission change without regenerating', async () => {
    const { world, service } = await indexed()
    const chart = world.exhibit('10-family-physician-chart.txt')
    const status = () => service.list(world.matterId, { exhibitId: chart, type: 'passage' }).entries[0].sources[0].admission
    expect(status()).toEqual({ status: 'not_decided', purposes: [] })

    const save = (changes: Record<string, { status: 'limited' | 'excluded'; purposes?: string[] }>) => world.workflow.saveAdmissionLedger(world.matterId, {
      reason: 'Test ruling',
      evidenceUses: world.store.listEvidence(world.matterId).map((item) => {
        const change = changes[item.name]
        return { evidenceId: item.id, status: change?.status ?? 'admitted', purposes: change?.purposes ?? [], redactions: [], hiddenFrom: [], note: '' }
      }),
    })
    const first = save({})
    expect(status()).toEqual({ status: 'admitted', purposes: [], ledgerId: first.id })
    const second = save({ '10-family-physician-chart.txt': { status: 'limited', purposes: ['credibility only'] } })
    expect(status()).toEqual({ status: 'limited', purposes: ['credibility only'], ledgerId: second.id })
    save({ '10-family-physician-chart.txt': { status: 'excluded' } })
    expect(status().status).toBe('excluded')
    expect(service.list(world.matterId, { admission: 'excluded', pageSize: 200 }).entries.every((entry) => entry.sources.some((source) => source.admission.status === 'excluded'))).toBe(true)
    // No regeneration happened: still one saved index version.
    expect(world.service.list(world.matterId, { kind: 'evidence_index' })).toHaveLength(1)
  })
})

describe('F5 coverage matches the answer key', () => {
  it('finds the planted record gaps: lines the sources state about missing material, plus the model\'s one absence', async () => {
    const { world, service } = await indexed()
    const evidence = world.store.listEvidence(world.matterId)
    const nameOf = (gap: { sources: Array<{ evidenceId: string }> }) => evidence.find((item) => item.id === gap.sources[0].evidenceId)!.name

    // Code alone finds the four gaps a source states, and nothing in the other files.
    const fromCode = detectRecordGaps(evidence)
    expect(fromCode.map(nameOf).sort()).toEqual(['05-incident-report.txt', '08-adjuster-letter.txt', '11-physiotherapy-records.txt', '16-discovery-excerpt-greyvale.txt'])
    for (const gap of fromCode) expect(checkPassage(gap.sources[0], evidence)).toBeNull()

    const coverage = service.coverage(world.matterId)
    for (const planted of answerKey.gaps) {
      const found = coverage.recordGaps.filter((gap) => gap.sources.length && nameOf(gap) === planted.pointer.file)
      expect(found.length, `${planted.id} ${planted.description}`).toBeGreaterThan(0)
      // The gap's passage is in the same paragraph as the key's pointer.
      expect(civilText.get(planted.pointer.file)!.includes(planted.pointer.quote)).toBe(true)
      expect(found.some((gap) => gap.sources[0].paragraph === 1)).toBe(true)
    }
    // G4 is an absence no source states: only the model could find it.
    expect(coverage.recordGaps.find((gap) => nameOf(gap as never) === '06-winter-service-log.txt')?.origin).toBe('model')
    expect(fromCode.some((gap) => nameOf(gap) === '06-winter-service-log.txt')).toBe(false)
    // The gap set is exactly the five planted gaps: no extras from the model's flawed reply.
    expect(coverage.recordGaps).toHaveLength(answerKey.gaps.length)
    expect(coverage.notes.join(' ')).toMatch(/absence no source mentions/)
  })

  it('does not flag gaps in sources that say nothing is missing (valid controls)', () => {
    const clean = [...civilText.entries()].filter(([name]) => !['05-incident-report.txt', '08-adjuster-letter.txt', '11-physiotherapy-records.txt', '16-discovery-excerpt-greyvale.txt'].includes(name))
    expect(clean).toHaveLength(civilFiles.length - 4)
  })

  it('lists every element with no support, no contrary evidence, and every source mapped to nothing', async () => {
    const { world, service } = await indexed()
    const empty = service.coverage(world.matterId)
    expect(empty.elements).toHaveLength(6)
    expect(empty.noSupport).toHaveLength(6)
    expect(empty.noContrary).toHaveLength(6)
    expect(empty.unmappedSources).toHaveLength(19)
    expect(empty.elements[0]).toMatchObject({ verdictQuestion: 'Did Tamarack fail to take reasonable care for the Plaintiff\'s safety?' })
    expect(empty.elements.find((element) => element.issueId === 'issue-greyvale')?.verdictQuestion).toBe('Negligence: Greyvale')

    const incident = service.suggestions(world.matterId).find((suggestion) => suggestion.assertion === 'record')!
    service.acceptSuggestion(world.matterId, incident.id)
    const mapped = service.coverage(world.matterId)
    expect(mapped.unmappedSources).toHaveLength(18)
    expect(mapped.unmappedSources.some((source) => source.exhibitId === world.exhibit('05-incident-report.txt'))).toBe(false)
    expect(mapped.noSupport).toHaveLength(5)
    expect(mapped.noSupport.some((row) => row.elementId === 'el-salt')).toBe(false)
    expect(mapped.caseModelVersion).toBe(world.model.version + 1)
  })

  it('includes record-scope missing materials the user entered', async () => {
    const { world, service } = await indexed()
    const scoped = world.workflow.reviseCaseModel(world.model.id, {
      recordScope: { description: 'Scope', documents: [], missingMaterials: [{ label: 'Notice of claim', status: 'not_supplied', note: 'Not in the packet' }, { label: 'Ignored', status: 'not_applicable', note: '' }] },
    })
    world.workflow.approveCaseModel(scoped.id)
    const gap = service.coverage(world.matterId).recordGaps.filter((candidate) => candidate.origin === 'record_scope')
    expect(gap.map((entry) => entry.description)).toEqual(['Notice of claim: Not in the packet'])
  })
})

describe('F5 listing: filters, paging and viewers', () => {
  it('pages deterministically and filters by type, exhibit, issue, element, assertion and text', async () => {
    const { world, service } = await indexed()
    const everything = service.list(world.matterId, { pageSize: 200 })
    expect(everything.total).toBeGreaterThan(25)
    expect(everything.ledger).toBeNull()
    expect(everything.extraction.status).toBe('draft')
    const pageOne = service.list(world.matterId, { page: 1, pageSize: 10 })
    const pageTwo = service.list(world.matterId, { page: 2, pageSize: 10 })
    expect(pageOne.entries).toHaveLength(10)
    expect(pageOne.entries.map((entry) => entry.id)).toEqual(everything.entries.slice(0, 10).map((entry) => entry.id))
    expect(pageTwo.entries.map((entry) => entry.id)).toEqual(everything.entries.slice(10, 20).map((entry) => entry.id))
    // A page past the end is clamped to the last page; the page size is capped.
    expect(service.list(world.matterId, { page: 999, pageSize: 10 }).page).toBe(Math.ceil(everything.total / 10))
    expect(service.list(world.matterId, { pageSize: 100_000 }).pageSize).toBe(200)

    expect(service.list(world.matterId, { type: 'expert_opinion' }).total).toBe(5)
    expect(service.list(world.matterId, { exhibitId: world.exhibit('12-expert-report-plaintiff-orthopaedic.txt') }).entries.every((entry) => entry.sources.some((source) => source.exhibitId === world.exhibit('12-expert-report-plaintiff-orthopaedic.txt')))).toBe(true)
    expect(service.list(world.matterId, { issueId: 'issue-damages' }).total).toBe(5)
    expect(service.list(world.matterId, { assertion: 'admission' }).total).toBe(1)
    expect(service.list(world.matterId, { q: 'cannot explain' }).entries.length).toBeGreaterThan(0)
    expect(service.list(world.matterId, { q: 'zzz-no-such-text' }).total).toBe(0)
    expect(service.list(world.matterId, { type: 'matrix_link' }).total).toBe(0)
  })

  it('maps matrix links to the verdict question and element', async () => {
    const { world, service } = await indexed()
    service.acceptSuggestion(world.matterId, service.suggestions(world.matterId).find((suggestion) => suggestion.assertion === 'record')!.id)
    const links = service.list(world.matterId, { type: 'matrix_link' })
    expect(links.total).toBe(1)
    expect(links.entries[0].mappings[0]).toMatchObject({ issueId: 'issue-greyvale', verdictQuestion: 'Negligence: Greyvale', elementId: 'el-salt', stance: 'supporting' })
    expect(service.list(world.matterId, { elementId: 'el-salt' }).total).toBe(1)
  })

  it('shows a party only its own side\'s theory claims, and the owner both', async () => {
    const world = buildCivilWorld()
    const revised = world.workflow.reviseCaseModel(world.model.id, {
      disputedFacts: [{
        id: 'fact-1', proposition: 'Salt was applied before the fall', issueIds: ['issue-greyvale'], attribution: 'source',
        supporting: [{ evidenceId: world.byFile.get('06-winter-service-log.txt')!.id, quote: '2025-01-14 05:30 Salt applied, lot and all walkways. Crew G-2.', locator: { paragraph: 1 }, attribution: 'source' }], contradicting: [],
      }],
    })
    const approved = world.workflow.approveCaseModel(revised.id)
    world.workflow.saveTheoryBrief({ caseModelId: approved.id, partyId: 'ellery', side: 'plaintiff', narrative: 'Plaintiff theory with a marker PLAINTIFF_ONLY_MARK.' })
    world.workflow.saveTheoryBrief({ caseModelId: approved.id, partyId: 'greyvale', side: 'defence', narrative: 'Defence theory.' })
    const service = new EvidenceIndexService(world.store, world.service, world.workflow)
    const claims = (viewer: Parameters<EvidenceIndexService['list']>[2]) => service.list(world.matterId, { type: 'theory_claim', pageSize: 200 }, viewer).entries
    expect(claims({ role: 'owner' }).map((entry) => entry.partyId).sort()).toEqual(['ellery', 'greyvale'])
    expect(claims({ role: 'party', partyId: 'ellery' }).map((entry) => entry.partyId)).toEqual(['ellery'])
    expect(claims({ role: 'party', partyId: 'greyvale' }).map((entry) => entry.partyId)).toEqual(['greyvale'])
    for (const entry of claims({ role: 'owner' })) expect(entry.countsAsEvidence).toBe(false)
    expect(service.list(world.matterId, { type: 'disputed_fact' }).total).toBe(1)
  })
})
