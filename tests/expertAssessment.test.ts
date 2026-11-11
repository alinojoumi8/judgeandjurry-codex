import { afterEach, describe, expect, it } from 'vitest'

import {
  admissibilityView,
  codeIndicators,
  compareExperts,
  ExpertAssessmentService,
  ExpertError,
  indicatorThresholds,
  jurorImpactLabel,
  type ExpertAssessmentContent,
  type ExpertEntry,
  type ExpertJurorImpact,
} from '../server/analysis/expertAssessment'
import { normalize } from '../server/grounding'
import { checkPassage } from '../server/analysis/sourceCheck'
import { StructuredModelError } from '../server/analysis/structured'
import { addSource, cleanupAnalysisFixtures } from './analysisFixtures'
import { answerKey, buildCivilWorld, civilText, documentOf, routedClient, type CivilWorld, type Router } from './intelligenceFixtures'

afterEach(cleanupAnalysisFixtures)

interface Flaws {
  fabricateQualification?: boolean
  noBasisFinding?: boolean
  inventedQuote?: boolean
  reputationClaim?: boolean
  foreignDocument?: boolean
  onlyBadFindings?: boolean
}

const topics: Record<string, string[]> = {
  castellane: ['future knee replacement', 'capacity to work'],
  lindqvist: ['Future knee replacement', 'Work capacity'],
  marchetti: ['economic loss'],
}

function expertRouter(world: CivilWorld, flaws: Flaws = {}): Router {
  const byExhibit = new Map([...world.byFile].map(([file, item]) => [item.exhibitId, file]))
  const src = (file: string, quote: string) => ({ evidenceId: world.exhibit(file), paragraph: 1, quote })
  return (request) => {
    const file = byExhibit.get(documentOf(request)!)!
    const expert = answerKey.experts.find((candidate) => candidate.file === file)!
    if (request.task === 'expert_record_extraction') {
      const text = civilText.get(file)!
      const line = (start: string) => text.split('\n').find((entry) => entry.startsWith(start))!
      const retained = line('Retained by') || undefined
      const assumptions = text.split('\n').filter((entry) => /assum/i.test(entry) && !entry.startsWith('Assumptions'))
      return { experts: [{
        name: expert.name, field: expert.field,
        ...(retained ? { retainedBy: { text: retained, sources: [src(file, retained)] } } : {}),
        identity: [src(file, text.split('\n')[0].slice(0, 60))],
        qualifications: expert.qualificationsStated
          ? [{ text: 'A practising orthopaedic surgeon', sources: [src(file, 'I am a practising orthopaedic surgeon.')] }]
          : flaws.fabricateQualification ? [{ text: 'Chartered business valuator', sources: [src(file, 'Chartered Business Valuator with twenty years of practice.')] }] : [],
        compensation: [],
        dataRelied: file.startsWith('12-') ? [{ text: 'Hospital and physiotherapy records', sources: [src(file, 'I reviewed the Port Alder General Hospital emergency record and the physiotherapy records received to date.')] }] : [],
        assumptions: assumptions.map((entry) => ({ text: entry, sources: [src(file, entry)] })),
        opinions: expert.opinions.map((opinion, index) => ({ topic: topics[expert.id][index] ?? 'economic loss', statement: opinion.summary, sources: [src(file, opinion.quote)] })),
      }] }
    }
    if (request.task === 'expert_assessment') {
      const findings: unknown[] = []
      if (flaws.onlyBadFindings) {
        findings.push({ dimension: 'bias', polarity: 'negative', statement: 'Probably aligned with the defence.', basis: [] })
        return { findings }
      }
      if (expert.id === 'castellane') {
        findings.push({
          dimension: 'assumptions', polarity: 'negative', statement: 'The report assumes no earlier left knee complaints, but the family physician chart records one in November 2023.',
          basis: [src('12-expert-report-plaintiff-orthopaedic.txt', 'I have assumed that the patient had no left knee complaints before January 14, 2025.'), src('10-family-physician-chart.txt', '2023-11-08: C/O left knee pain x 3 weeks after kneeling at work.')],
        }, { dimension: 'qualification_fit', polarity: 'positive', statement: 'The report states the expert is a practising orthopaedic surgeon, matching the knee opinions.', basis: [src(file, 'I am a practising orthopaedic surgeon.')] })
      }
      if (expert.id === 'lindqvist') {
        findings.push({ dimension: 'bias', polarity: 'negative', statement: 'The report itself says most retainers come from insurers or defence counsel.', basis: [src(file, 'In the past five years, 94 percent of my medico-legal retainers have come from insurers or defence counsel.')] })
      }
      if (expert.id === 'marchetti') {
        findings.push({
          dimension: 'assumptions', polarity: 'negative', statement: 'The assumed income of $84,000 is higher than the employer\'s figure for 2024.',
          basis: [src(file, 'Annual income assumed: $84,000'), src('17-employer-earnings-letter.txt', 'Total gross earnings for 2024: $73,180')],
        })
      }
      if (flaws.noBasisFinding) findings.push({ dimension: 'cross_vulnerability', polarity: 'negative', statement: 'Will be weak on cross-examination.', basis: [] })
      if (flaws.inventedQuote) findings.push({ dimension: 'method', polarity: 'negative', statement: 'Used an unusual method.', basis: [src(file, 'I used an experimental method nobody has reviewed.')] })
      if (flaws.reputationClaim) findings.push({ dimension: 'bias', polarity: 'negative', statement: 'The expert has a reputation as a hired gun.', basis: [src(file, 'In the past five years, 94 percent of my medico-legal retainers have come from insurers or defence counsel.')] })
      if (flaws.foreignDocument) findings.push({ dimension: 'method', polarity: 'negative', statement: 'Cites a document that was not supplied.', basis: [{ evidenceId: 'E-099', paragraph: 1, quote: 'Some quotation from nowhere.' }] })
      return { findings }
    }
    throw new Error(`Unexpected task ${request.task}`)
  }
}

async function assessed(flaws: Flaws = {}, tweak?: (world: CivilWorld) => void) {
  const world = buildCivilWorld()
  tweak?.(world)
  const client = routedClient(expertRouter(world, flaws))
  const service = new ExpertAssessmentService(world.store, world.service)
  const artifact = await service.generate(world.matterId, { client })
  const content = artifact.content as unknown as ExpertAssessmentContent
  const entry = (id: string) => content.items.find((item) => item.record.name === answerKey.experts.find((expert) => expert.id === id)!.name)!
  return { world, client, service, artifact, content, entry }
}

describe('F7 expert records (scripted model, source-checked)', () => {
  it('extracts each expert record and sets qualificationsStated from verified items, as the answer key says', async () => {
    const { world, artifact, content, client, entry } = await assessed()
    expect(artifact).toMatchObject({ kind: 'expert_assessment', status: 'draft' })
    expect(content.items).toHaveLength(3)
    // Two calls per expert report: one to extract the record, one to assess it.
    expect(client.calls).toHaveLength(6)
    for (const expert of answerKey.experts) {
      const item = entry(expert.id)
      expect(item.record.qualificationsStated, expert.name).toBe(expert.qualificationsStated)
      expect(item.record.field).toBe(expert.field)
      expect(item.record.opinions).toHaveLength(expert.opinions.length)
      for (const opinion of item.record.opinions) expect(opinion.assertion).toBe('expert_opinion')
    }
    expect(entry('castellane').record.retainedBy?.text).toMatch(/Hollis Varga LLP/)
    expect(entry('marchetti').record.retainedBy).toBeUndefined()
    const evidence = world.store.listEvidence(world.matterId)
    for (const item of content.items) {
      for (const source of [...item.record.identity, ...item.record.opinions.flatMap((opinion) => opinion.sources), ...item.record.qualifications.flatMap((entryItem) => entryItem.sources)]) {
        expect(checkPassage(source, evidence)).toBeNull()
      }
    }
    expect(artifact.rejected).toEqual([])
  })

  it('does not count a fabricated qualification: it is refused and the report still has none stated', async () => {
    const { artifact, entry } = await assessed({ fabricateQualification: true })
    const marchetti = entry('marchetti')
    expect(marchetti.record.qualificationsStated).toBe(false)
    expect(marchetti.record.qualifications).toEqual([])
    expect(artifact.rejected.some((item) => /Qualification refused/.test(item.reason) && /does not appear in that paragraph/.test(item.reason))).toBe(true)
    expect(marchetti.indicators.map((indicator) => indicator.code)).toContain('no_qualifications_stated')
  })

  it('flags a report with no stated qualifications, and not the reports that state them (valid controls)', async () => {
    const { entry } = await assessed()
    const codes = (id: string) => entry(id).indicators.map((indicator) => indicator.code)
    expect(codes('marchetti')).toContain('no_qualifications_stated')
    expect(codes('castellane')).not.toContain('no_qualifications_stated')
    expect(codes('lindqvist')).not.toContain('no_qualifications_stated')
    expect(entry('marchetti').indicators.find((indicator) => indicator.code === 'no_qualifications_stated')?.statement).toMatch(/court file number/)
  })

  it('does not treat a court file number as a qualification', async () => {
    const { entry } = await assessed({}, (world) => {
      const item = world.byFile.get('14-expert-report-economic-loss.txt')!
      // The report with a CV- file number in its text is still a report with no stated qualification.
      expect(civilText.get('14-expert-report-economic-loss.txt')).not.toMatch(/CV-/)
      expect(item.text).not.toMatch(/CV-/)
    })
    expect(entry('marchetti').record.qualificationsStated).toBe(false)
    expect(civilText.get('12-expert-report-plaintiff-orthopaedic.txt')).toMatch(/CV-25-00000-FICT/)
    expect(entry('castellane').record.qualificationsStated).toBe(true)
  })
})

describe('F7 planted weaknesses are found, each with a checked basis', () => {
  it('finds every planted weakness in the answer key through code indicators or cited findings', async () => {
    const { content, world } = await assessed()
    const evidence = world.store.listEvidence(world.matterId)
    const nameOf = (id: string) => evidence.find((item) => item.id === id)!.name
    const cited = content.items.flatMap((item) => [
      ...item.indicators.flatMap((indicator) => indicator.basis),
      ...item.findings.flatMap((finding) => finding.basis),
    ])
    let found = 0
    for (const expert of answerKey.experts) {
      for (const weakness of expert.plantedWeaknesses) {
        const hit = cited.find((source) => nameOf(source.evidenceId) === weakness.file && normalize(source.quote).includes(normalize(weakness.quote)))
        expect(hit, `${expert.id}: ${weakness.description}`).toBeDefined()
        found += 1
      }
    }
    expect(found).toBe(6)
    // Every cited passage checks against the record.
    for (const source of cited) expect(checkPassage(source, evidence)).toBeNull()
  })

  it('reads the three Lindqvist weaknesses and the two Marchetti assumptions straight from the text', async () => {
    const { entry } = await assessed()
    const codes = (id: string) => entry(id).indicators.map((indicator) => indicator.code).sort()
    expect(codes('lindqvist')).toEqual(['limited_record_reviewed', 'no_compensation_stated', 'retainer_concentration', 'short_examination'])
    const short = entry('lindqvist').indicators.find((indicator) => indicator.code === 'short_examination')!
    expect(short.statement).toMatch(new RegExp(`under ${indicatorThresholds.shortExaminationMinutes} minutes`))
    expect(entry('lindqvist').indicators.find((indicator) => indicator.code === 'retainer_concentration')!.statement).toMatch(/not proof of bias/)
    expect(codes('marchetti').filter((code) => code === 'assumption_without_stated_basis')).toHaveLength(2)
    // Castellane's assumption is stated with no basis too.
    expect(codes('castellane')).toContain('assumption_without_stated_basis')
  })

  it('does not flag an examination of normal length, a modest retainer share or a stated basis (valid controls)', () => {
    const record = (assumption: string) => ({
      id: 'expert-1', evidenceId: 'e', exhibitId: 'E-001', name: 'Dr. X', field: 'f', identity: [{ evidenceId: 'e', paragraph: 1, quote: 'Report of Dr. X.' }],
      qualificationsStated: true, qualifications: [], compensation: [{ text: 'fee', sources: [] }], dataRelied: [],
      assumptions: [{ text: assumption, sources: [{ evidenceId: 'e', paragraph: 1, quote: assumption }] }], opinions: [],
    })
    const document = (text: string) => ({ id: 'e', matterId: 'm', exhibitId: 'E-001', name: 'r.txt', type: 'text', mimeType: 'text/plain', size: text.length, text, summary: '', tags: [], uploadedAt: '', sha256: null, sourceAvailable: true, ingestionStatus: 'stored', extractionWarning: null, archivedAt: null }) as never
    const text = 'Report of Dr. X.\nThe physical examination lasted 60 minutes.\nIn the past five years, 40 percent of my retainers have come from insurers.\nI assumed a retirement age of 65 because the pension plan says so.'
    const indicators = codeIndicators(record('I assumed a retirement age of 65 because the pension plan says so.') as never, document(text))
    expect(indicators.map((indicator) => indicator.code)).toEqual([])
  })
})

describe('F7 an assessment without a cited basis is rejected', () => {
  it('refuses findings with no basis, an invented quotation, an unsupplied document or an unsupported reputation claim, and keeps the valid ones', async () => {
    const { artifact, entry } = await assessed({ noBasisFinding: true, inventedQuote: true, foreignDocument: true, reputationClaim: true })
    const reasons = artifact.rejected.map((item) => item.reason)
    expect(reasons.filter((reason) => /no cited basis/.test(reason))).toHaveLength(3)
    // Three invented quotations, plus the reputation claim's basis cited against two reports that do not contain it.
    expect(reasons.filter((reason) => /does not appear in that paragraph/.test(reason))).toHaveLength(5)
    expect(reasons.filter((reason) => /was not supplied in this call/.test(reason))).toHaveLength(3)
    // Where the quotation is real (Lindqvist's own report) the claim is still refused: the passage says nothing about reputation.
    expect(reasons.filter((reason) => /reputation needs a cited source/.test(reason))).toHaveLength(1)
    // The valid finding survives for each expert; none of the flawed ones does.
    expect(entry('lindqvist').findings.map((finding) => finding.dimension)).toEqual(['bias'])
    expect(entry('castellane').findings.map((finding) => finding.dimension).sort()).toEqual(['assumptions', 'qualification_fit'])
    for (const item of [entry('castellane'), entry('lindqvist'), entry('marchetti')]) {
      expect(item.assessment.status).toBe('assessed')
      for (const finding of item.findings) expect(finding.basis.length).toBeGreaterThan(0)
    }
  })

  it('rejects the whole assessment when no finding cites the record', async () => {
    const { artifact, content } = await assessed({ onlyBadFindings: true })
    for (const item of content.items) {
      expect(item.findings).toEqual([])
      expect(item.assessment).toMatchObject({ status: 'rejected', reason: expect.stringMatching(/cited a checked basis/) })
    }
    expect(artifact.rejected.filter((item) => /assessment was rejected/.test(item.reason))).toHaveLength(3)
    // The code indicators still stand: they cite the text themselves.
    expect(content.items.some((item) => item.indicators.length > 0)).toBe(true)
  })

  it('accepts a claim about reputation only when a cited passage says so (valid control)', async () => {
    const { entry } = await assessed({ reputationClaim: true }, (world) => {
      addSource(world.store, world.matterId, '20-profile.txt', 'Profile note.\nDr. Lindqvist is well-known as a defence expert.')
    })
    // The cited retainer line says nothing about reputation, so the claim is still refused.
    expect(entry('lindqvist').findings.map((finding) => finding.statement)).not.toContain('The expert has a reputation as a hired gun.')

    const world = buildCivilWorld()
    const profile = addSource(world.store, world.matterId, '20-profile.txt', 'Profile note.\nDr. Lindqvist is well-known as a defence expert.')
    const base = expertRouter(world)
    const router: Router = (request) => {
      const reply = base(request) as { findings?: unknown[] }
      if (request.task === 'expert_assessment' && documentOf(request) === world.exhibit('13-expert-report-defence-orthopaedic.txt')) {
        reply.findings!.push({
          dimension: 'bias', polarity: 'neutral', statement: 'A profile note says the expert is well-known.',
          basis: [{ evidenceId: profile.exhibitId, paragraph: 1, quote: 'Dr. Lindqvist is well-known as a defence expert.' }],
        })
      }
      return reply
    }
    const service = new ExpertAssessmentService(world.store, world.service)
    const artifact = await service.generate(world.matterId, { client: routedClient(router) })
    const lindqvist = (artifact.content as unknown as ExpertAssessmentContent).items.find((item) => item.record.name === 'Dr. Tobias Lindqvist')!
    expect(lindqvist.findings.map((finding) => finding.statement)).toContain('A profile note says the expert is well-known.')
  })
})

describe('F7 comparison, clarity and admissibility', () => {
  it('puts opposing experts side by side opinion by opinion, and leaves a lone expert out', async () => {
    const { content } = await assessed()
    expect(content.comparisons).toHaveLength(2)
    const topicsFound = content.comparisons.map((comparison) => comparison.topic.toLowerCase()).sort()
    expect(topicsFound).toEqual(['capacity to work', 'future knee replacement'])
    for (const comparison of content.comparisons) {
      expect(comparison.positions.map((position) => position.expertName).sort()).toEqual(['Dr. Renata Castellane', 'Dr. Tobias Lindqvist'])
      expect(comparison.note).toMatch(/code does not decide/)
    }
    expect(content.comparisons.some((comparison) => comparison.positions.some((position) => position.expertName === 'P. Marchetti'))).toBe(false)
    expect(compareExperts([])).toEqual([])
  })

  it('computes readability and jargon density in code for each report and its opinions', async () => {
    const { entry } = await assessed()
    const ortho = entry('castellane').readability
    expect(ortho.report.words).toBeGreaterThan(40)
    expect(ortho.report.note).toMatch(/Stated heuristic/)
    expect(ortho.report.jargon.words).toBeGreaterThan(0)
    expect(ortho.opinions.words).toBeGreaterThan(5)
    expect(entry('marchetti').readability.report.fleschKincaidGrade).not.toBeNaN()
  })

  it('treats admissibility criteria as unknown by default and does not assume them', async () => {
    const { content } = await assessed()
    expect(content.admissibility).toMatchObject({ status: 'unknown', assessed: false, criteria: [] })
    expect(content.admissibility.message).toMatch(/No admissibility conclusion is offered/)
    expect(content.items.every((item) => item.findings.every((finding) => finding.dimension !== 'admissibility'))).toBe(true)
  })

  it('reports each supplied criterion as assessed only when a cited finding names it', () => {
    const entry = (criterionId?: string): ExpertEntry => ({
      record: { id: 'expert-1' } as never, indicators: [], readability: {} as never, assessment: { status: 'assessed' },
      findings: criterionId ? [{ id: 'expert-1-f-1', dimension: 'admissibility', polarity: 'neutral', statement: 's', criterionId, basis: [] }] : [],
    })
    const criteria = { status: 'known' as const, packHash: 'abc', criteria: [{ id: 'necessity', label: 'Necessity' }, { id: 'qualified', label: 'Properly qualified' }] }
    const partial = admissibilityView(criteria, [entry('necessity')])
    expect(partial).toMatchObject({ status: 'known', assessed: false, packHash: 'abc' })
    expect(partial.criteria).toEqual([
      { id: 'necessity', label: 'Necessity', findingIds: ['expert-1-f-1'], assessed: true }, { id: 'qualified', label: 'Properly qualified', findingIds: [], assessed: false },
    ])
    expect(admissibilityView(criteria, [entry('necessity'), entry('qualified')]).assessed).toBe(true)
    expect(admissibilityView({ status: 'unknown' }, []).assessed).toBe(false)
  })

  it('passes supplied criteria to the model call and records them', async () => {
    const world = buildCivilWorld()
    const client = routedClient(expertRouter(world))
    const service = new ExpertAssessmentService(world.store, world.service)
    const artifact = await service.generate(world.matterId, { client, admissibility: { status: 'known', criteria: [{ id: 'necessity', label: 'Necessity' }] } })
    const call = client.calls.find((entry) => entry.request.task === 'expert_assessment')!
    expect(call.request.instructions).toMatch(/necessity: Necessity/)
    expect((artifact.content as unknown as ExpertAssessmentContent).admissibility).toMatchObject({ status: 'known', assessed: false })
  })

  it('has a typed, empty hook for simulated juror impact', async () => {
    const hook: ExpertJurorImpact = { simulated: true, label: jurorImpactLabel, expertId: 'expert-1', appraisals: [] }
    expect(hook.label).toMatch(/Simulated juror reaction/)
    const { content } = await assessed()
    expect(content.jurorImpact).toBeNull()
  })
})

describe('F7 robustness', () => {
  it('refuses to run when there is no expert report, and runs on a document the user chooses', async () => {
    const world = buildCivilWorld()
    const service = new ExpertAssessmentService(world.store, world.service)
    // Classification finds the three fixture reports and nothing else.
    expect(service.expertDocuments(world.matterId).map((item) => item.name)).toEqual([
      '12-expert-report-plaintiff-orthopaedic.txt', '13-expert-report-defence-orthopaedic.txt', '14-expert-report-economic-loss.txt',
    ])
    expect(() => service.expertDocuments(world.matterId, ['missing'])).toThrow(ExpertError)
    const none = buildCivilWorld()
    none.store.workflow.listCaseModels(none.matterId)
    const emptyStore = (await import('./analysisFixtures')).memoryStore()
    const matter = emptyStore.createMatter({ title: 'Empty', narrative: 'n' })
    addSource(emptyStore, matter.id, 'note.txt', 'An ordinary note.')
    const { AnalysisService } = await import('../server/analysis/service')
    await expect(new ExpertAssessmentService(emptyStore, new AnalysisService(emptyStore)).generate(matter.id, { client: routedClient(() => ({})) })).rejects.toThrow(/No expert reports/)
  })

  it('records a failed model step for one expert and still saves the others', async () => {
    const world = buildCivilWorld()
    const base = expertRouter(world)
    const client = routedClient((request) => {
      if (request.task === 'expert_assessment' && documentOf(request) === world.exhibit('13-expert-report-defence-orthopaedic.txt')) {
        throw new StructuredModelError('provider unavailable', { category: 'provider_error', audit: { task: request.task, promptVersion: 'x', provider: 'scripted', model: 'scripted', mode: 'scripted', attempts: 1 } })
      }
      return base(request)
    })
    const artifact = await new ExpertAssessmentService(world.store, world.service).generate(world.matterId, { client })
    const items = (artifact.content as unknown as ExpertAssessmentContent).items
    const lindqvist = items.find((item) => item.record.name === 'Dr. Tobias Lindqvist')!
    expect(lindqvist.assessment).toEqual({ status: 'not_run', reason: 'The model step failed (provider_error).' })
    expect(items.filter((item) => item.assessment.status === 'assessed')).toHaveLength(2)
    // The code indicators are still there for the expert whose model step failed.
    expect(lindqvist.indicators.length).toBeGreaterThan(0)
  })

  it('does not truncate: a record over the character limit is listed, not cut', async () => {
    const { content } = await assessed({}, (world) => addSource(world.store, world.matterId, '20-big.txt', `A big note. ${'x'.repeat(250_000)}`))
    for (const item of content.items) expect(item.assessment).toMatchObject({ status: 'not_run', reason: expect.stringMatching(/Nothing was truncated/) })
  })

  it('keeps the planted injection in the delimited documents and out of the instructions and output', async () => {
    const { client, content, artifact } = await assessed()
    const { canary, line } = answerKey.injection
    const withLog = client.calls.filter((call) => call.request.task === 'expert_assessment')
    expect(withLog).toHaveLength(3)
    for (const call of withLog) {
      expect(call.request.inputs.some((input) => input.text.includes(line))).toBe(true)
      expect(call.prompt.system).not.toContain(canary)
      expect(call.request.instructions).not.toContain(canary)
    }
    expect(JSON.stringify([content, artifact.rejected])).not.toContain(canary)
  })

  it('saves a draft that is approved through the normal path, and reads back as a view', async () => {
    const { world, service } = await assessed()
    expect(service.view(world.matterId)).toMatchObject({ current: 'draft', draft: { freshness: { status: 'current' } } })
    service.approve(world.matterId)
    const views = service.view(world.matterId)
    expect(views).toMatchObject({ current: 'approved', approved: { artifact: { status: 'approved' } } })
    expect(world.service.approvedFor({ role: 'owner' }, world.matterId, 'expert_assessment')).toHaveLength(1)
    expect(() => service.approve(world.matterId)).toThrow(/no draft/)
  })
})
