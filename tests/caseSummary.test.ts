import { afterEach, describe, expect, it } from 'vitest'

import { CaseSummaryError, prepareSentences, type CaseSummaryReply } from '../server/analysis/caseSummary'
import { authorityMentions, allowListFor, unapprovedAuthorities } from '../server/analysis/caseSummaryAuthorities'
import type { ApprovedAuthority } from '../server/analysis/caseSummaryTypes'
import { cleanupAnalysisFixtures } from './analysisFixtures'
import { canaries, claimQuote, incidentQuote, summaryClient, summaryWorld, type ReplySentence } from './caseSummaryFixtures'

afterEach(cleanupAnalysisFixtures)

const owner = { role: 'owner' } as const
const outsideNames = ['Marshall v. Crestview Holdings', 'Crestview', '1999 ONCA 123', 'Property Safety Act', 's. 42', 'Smith v. Jones', '2001 SCC 99']

describe('case summary authority allow-list (unit)', () => {
  const authorities: ApprovedAuthority[] = [
    { id: 'pack:1', origin: 'rule_pack', kind: 'statute', title: 'Courts of Justice Act, R.S.O. 1990, c. C.43', citation: 'Courts of Justice Act, R.S.O. 1990, c. C.43', pinpoint: 's. 108(6); s. 118', reviewStatus: 'unreviewed' },
    { id: 'pack:2', origin: 'rule_pack', kind: 'case', title: 'Whiten v. Pilot Insurance Co., 2002 SCC 18', citation: 'Whiten v. Pilot Insurance Co., 2002 SCC 18', pinpoint: 'punitive damages', reviewStatus: 'unreviewed' },
  ]
  const allow = allowListFor(authorities, 'Ellery v. Tamarack Quay Holdings Inc. and Greyvale Grounds Ltd.')

  it('finds case names, neutral citations, statutes and pinpoints in text', () => {
    const found = authorityMentions('Under Marshall v. Crestview Holdings, 1999 ONCA 123, and s. 42 of the Property Safety Act, the Negligence Act and Rule 53 apply.')
    expect(found).toEqual(expect.arrayContaining(['Marshall v. Crestview Holdings', '1999 ONCA 123', 's. 42', 'Property Safety Act', 'Negligence Act', 'Rule 53']))
    // Plain prose names nothing.
    expect(authorityMentions('The guard wrote down the time. The Act is long. See paragraph 3 of the report.')).toEqual([])
  })

  it('refuses an authority that is not on the list and passes the ones that are (valid controls)', () => {
    expect(unapprovedAuthorities('Marshall v. Crestview Holdings, 1999 ONCA 123 says so.', [], allow)).toEqual(expect.arrayContaining(['Marshall v. Crestview Holdings', '1999 ONCA 123']))
    expect(unapprovedAuthorities('Section 42 of the Property Safety Act applies.', [], allow)).toEqual(expect.arrayContaining(['Section 42', 'Property Safety Act']))
    // Approved: the statute, a pinpoint on it, the case with its short name, the matter's own caption.
    expect(unapprovedAuthorities('The Courts of Justice Act, s. 108(6) says five of six may answer, and s. 118 lets counsel suggest an amount.', [], allow)).toEqual([])
    expect(unapprovedAuthorities('Whiten v. Pilot Insurance Co., 2002 SCC 18 on punitive damages.', [], allow)).toEqual([])
    expect(unapprovedAuthorities('Whiten v. Pilot Insurance on punitive damages.', [], allow)).toEqual([])
    expect(unapprovedAuthorities('In Ellery v. Tamarack Quay Holdings Inc. the guard wrote this.', [], allow)).toEqual([])
    // Only whole tokens count: "s. 10" is not "s. 108".
    expect(unapprovedAuthorities('Section 10 of the Courts of Justice Act.', [], allow)).toEqual(['Section 10'])
  })

  it('lets a sentence repeat an authority its own cited quotation names, because that describes the record', () => {
    const text = 'The statement of claim says Tamarack breached the Occupiers\' Liability Act.'
    expect(unapprovedAuthorities(text, [], allow)).toEqual(['Occupiers\' Liability Act'])
    expect(unapprovedAuthorities(text, ['Tamarack breached its duty as occupier under the Occupiers\' Liability Act'], allow)).toEqual([])
  })
})

describe('prepareSentences (unit)', () => {
  const evidence: Parameters<typeof prepareSentences>[1]['evidence'] = [{
    id: 'ev-id-1', matterId: 'm', exhibitId: 'E-001', name: 'a.txt', type: 'text', mimeType: 'text/plain', size: 1, text: 'First paragraph.\n\nSecond paragraph says the walkway was icy.', summary: '', tags: [],
    uploadedAt: '', sha256: null, sourceAvailable: true, ingestionStatus: 'stored', extractionWarning: null, archivedAt: null,
  }]
  const context = { questions: new Map([['q1', new Set(['el-1'])]]), authorities: [] as ApprovedAuthority[], caption: 'A v. B', evidence }
  const reply = (sentences: CaseSummaryReply['sentences']): CaseSummaryReply => ({ sentences, needsResearch: [] })

  it('corrects a wrong paragraph number and an exhibit label, and records that it did', () => {
    const result = prepareSentences(reply([{ section: 'facts', text: 'The walkway was icy.', sources: [{ evidenceId: 'E-001', paragraph: 1, quote: 'the walkway was icy' }] }]), context)
    expect(result.rejected).toEqual([])
    expect(result.accepted[0].sources).toEqual([{ evidenceId: 'ev-id-1', paragraph: 2, quote: 'the walkway was icy' }])
    expect(result.accepted[0].warnings[0]).toMatch(/corrected from 1 to 2/)
  })

  it('leaves a quotation that is nowhere in the document for the source check to refuse', () => {
    const result = prepareSentences(reply([{ section: 'facts', text: 'Invented.', sources: [{ evidenceId: 'ev-id-1', paragraph: 1, quote: 'this text is not anywhere' }] }]), context)
    expect(result.accepted[0].sources[0].paragraph).toBe(1)
  })

  it('rejects an unknown question, an element of another question, and a verdict sentence with no question', () => {
    const base = { text: 'A sentence.', sources: [{ evidenceId: 'ev-id-1', paragraph: 2, quote: 'the walkway was icy' }] }
    const result = prepareSentences(reply([
      { ...base, section: 'claims_elements', questionKey: 'nope' }, { ...base, section: 'claims_elements', questionKey: 'q1', elementId: 'other' },
      { ...base, section: 'verdict_walk' }, { ...base, section: 'verdict_walk', questionKey: 'q1', elementId: 'el-1' },
    ]), context)
    expect(result.rejected.map((entry) => entry.reason)).toEqual([
      expect.stringMatching(/not in the approved case map/), expect.stringMatching(/does not belong to that question/), expect.stringMatching(/must say which question/),
    ])
    expect(result.accepted).toHaveLength(1)
  })
})

describe('case summaries: prerequisites', () => {
  it('names every missing approval in plain words, lists what was and was not available, and calls no model', async () => {
    const world = await summaryWorld({ chronology: false, evidenceIndex: false, caseMap: false })
    const report = world.summaries.prerequisites(world.matterId, 'ellery')
    expect(report.canGenerate).toBe(false)
    expect(report.blockers).toEqual([
      expect.stringMatching(/^Approved case map is missing\. There is no approved case map/),
      expect.stringMatching(/^Approved timeline is missing\./),
      expect.stringMatching(/^Approved evidence index is missing\./),
    ])
    expect(report.items.map((item) => [item.key, item.status, item.required])).toEqual([
      ['case_model', 'available', true], ['case_map', 'missing', true], ['chronology', 'missing', true], ['evidence_index', 'missing', true],
      ['expert_assessment', 'missing', false], ['court_rules', 'missing', false], ['own_theory', 'available', false],
    ])
    const client = summaryClient()
    await expect(world.summaries.generate(world.matterId, { client })).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/cannot be made yet.*Approved case map is missing/) })
    expect(client.calls).toHaveLength(0)
    expect(world.service.list(world.matterId, { kind: 'case_summary' })).toEqual([])
  })

  it('reports optional gaps without blocking: no expert reports, no court rules, no own theory', async () => {
    const world = await summaryWorld({ theories: false })
    const report = world.summaries.prerequisites(world.matterId, 'ellery')
    expect(report.canGenerate).toBe(true)
    const status = Object.fromEntries(report.items.map((item) => [item.key, item.status]))
    expect(status).toMatchObject({ case_map: 'available', chronology: 'available', evidence_index: 'available', court_rules: 'missing', own_theory: 'missing' })
    expect(report.items.find((item) => item.key === 'own_theory')!.detail).toMatch(/no saved private theory/)
    expect(report.items.find((item) => item.key === 'chronology')!.detail).toMatch(/2 accepted events/)
  })

  it('treats an unknown party as not found', async () => {
    const world = await summaryWorld()
    expect(() => world.summaries.prerequisites(world.matterId, 'nobody')).toThrowError(CaseSummaryError)
    expect(() => world.summaries.estimateCalls(world.matterId, ['nobody'])).toThrow(/not in this matter/)
  })
})

describe('case summaries: generation', () => {
  it('writes one summary per side in its own model call and defaults to the plaintiff', async () => {
    const world = await summaryWorld()
    expect(world.summaries.defaultPartyId(world.matterId)).toBe('ellery')
    expect(world.summaries.estimateCalls(world.matterId)).toBe(1)
    expect(world.summaries.estimateCalls(world.matterId, ['ellery', 'tamarack'])).toBe(2)
    const client = summaryClient()
    const artifacts = await world.summaries.generate(world.matterId, { client, partyIds: ['ellery', 'tamarack'] })
    expect(client.calls).toHaveLength(2)
    expect(artifacts.map((artifact) => [artifact.kind, artifact.subjectKey, artifact.audience, artifact.status, artifact.version])).toEqual([
      ['case_summary', 'ellery', 'party', 'draft', 1], ['case_summary', 'tamarack', 'party', 'draft', 1],
    ])
    const content = artifacts[0].content
    expect(content.party).toEqual({ id: 'ellery', name: 'Jordan Ellery', role: 'plaintiff' })
    expect(content.verdictWalk.length).toBeGreaterThan(5)
    expect(content.verdictWalk.map((question) => question.order)).toEqual(content.verdictWalk.map((_, index) => index))
    expect(content.prerequisites.map((item) => item.key)).toContain('case_map')
  })

  it('gives every accepted sentence at least one checked citation, and keeps failures visible', async () => {
    const world = await summaryWorld()
    const client = summaryClient({
      sentences: (_party, faithful) => [
        ...faithful,
        { section: 'facts', text: 'A sentence with no citation at all.', sources: [] },
        { section: 'facts', text: 'A sentence quoting words that are not in the source.', sources: [{ evidenceId: world.evidenceId('05-incident-report.txt'), paragraph: 1, quote: 'the walkway was perfectly salted' }] },
        { section: 'facts', text: 'A sentence citing a document that is not in the matter.', sources: [{ evidenceId: 'not-a-document', paragraph: 1, quote: 'glare ice, no visible salt' }] },
      ],
    })
    const [artifact] = await world.summaries.generate(world.matterId, { client })
    expect(artifact.content.items.length).toBeGreaterThan(5)
    for (const sentence of artifact.content.items) {
      expect(sentence.sources.length, sentence.text).toBeGreaterThan(0)
      for (const source of sentence.sources) expect(world.store.listEvidence(world.matterId).some((item) => item.id === source.evidenceId && item.text.includes(source.quote))).toBe(true)
    }
    expect(artifact.rejected.map((entry) => entry.reason)).toEqual([
      'The item cites no source passage.',
      expect.stringMatching(/does not appear in that paragraph/),
      expect.stringMatching(/not part of this matter's current evidence/),
    ])
    expect(artifact.content.items.map((item) => item.text)).not.toContain('A sentence with no citation at all.')
  })

  it('uses accepted events and evidence that counts as evidence, never a proposed event or an allegation', async () => {
    const world = await summaryWorld()
    const client = summaryClient()
    await world.summaries.generate(world.matterId, { client })
    const record = JSON.parse(client.calls[0].request.inputs.find((input) => input.id === 'neutral-record')!.text) as { events: Array<{ id: string }>; evidence: Array<{ id: string; kind: string }> }
    expect(record.events.map((event) => event.id)).toEqual(['ev-1', 'ev-2'])
    expect(record.evidence.map((entry) => entry.kind)).toEqual(['testimony'])
    const sent = client.calls[0].prompt.user
    expect(sent).not.toContain('statement of claim alleges a breach')
    expect(sent).not.toContain('pleads that Tamarack breached')
  })

  it('keeps each side\'s theory out of the other side\'s request and summary, in both directions', async () => {
    const world = await summaryWorld()
    const client = summaryClient({
      // A model that quotes its own theory back, as the worst case for leakage.
      sentences: (_partyId, faithful, request) => [...faithful, { section: 'theory', text: `Echo of own theory: ${(request.inputs.find((input) => input.id === 'own-theory')?.text ?? '').slice(0, 40)}`, sources: faithful[0].sources }],
    })
    const artifacts = await world.summaries.generate(world.matterId, { client, partyIds: ['ellery', 'tamarack'] })
    const requestOf = (partyId: string) => client.calls.find((call) => (JSON.parse(call.request.inputs.find((input) => input.id === 'case-map')!.text) as { party: { id: string } }).party.id === partyId)!
    const wholeRequest = (partyId: string) => JSON.stringify([requestOf(partyId).request.instructions, requestOf(partyId).prompt, requestOf(partyId).request.inputs])
    // Positive control: each side's own theory really reached its own request.
    expect(wholeRequest('ellery')).toContain(canaries.ellery)
    expect(wholeRequest('tamarack')).toContain(canaries.tamarack)
    // Denied, both directions, in every message of the other side's call.
    for (const other of [canaries.tamarack, canaries.greyvale]) expect(wholeRequest('ellery')).not.toContain(other)
    for (const other of [canaries.ellery, canaries.greyvale]) expect(wholeRequest('tamarack')).not.toContain(other)
    const text = (artifact: (typeof artifacts)[number]) => JSON.stringify(artifact)
    expect(text(artifacts[0])).not.toContain(canaries.tamarack)
    expect(text(artifacts[0])).not.toContain(canaries.greyvale)
    expect(text(artifacts[1])).not.toContain(canaries.ellery)
    expect(text(artifacts[1])).not.toContain(canaries.greyvale)
    // Nothing of a party-audience summary reaches the other party's read path.
    expect(world.service.approvedFor({ role: 'party', partyId: 'tamarack' }, world.matterId, 'case_summary')).toEqual([])
  })

  it('never reads a summary of one side when it writes the other side\'s', async () => {
    const world = await summaryWorld()
    const first = summaryClient({ sentences: (_party, faithful) => [...faithful, { section: 'weaknesses', text: 'SUMMARY_ONLY_CANARY_b81f lives in this sentence.', sources: faithful[0].sources }] })
    const [plaintiff] = await world.summaries.generate(world.matterId, { client: first, partyIds: ['ellery'] })
    world.summaries.approve(world.matterId, 'ellery')
    expect(JSON.stringify(plaintiff)).toContain('SUMMARY_ONLY_CANARY_b81f')
    const second = summaryClient()
    await world.summaries.generate(world.matterId, { client: second, partyIds: ['tamarack'] })
    expect(JSON.stringify(second.calls)).not.toContain('SUMMARY_ONLY_CANARY_b81f')
  })

  it('refuses every side before any model call when one of them is blocked or too large', async () => {
    const world = await summaryWorld()
    const client = summaryClient()
    await expect(world.summaries.generate(world.matterId, { client, partyIds: ['ellery', 'nobody'] })).rejects.toMatchObject({ status: 404 })
    expect(client.calls).toHaveLength(0)
  })

  it('stores a new version for each generation, and the earlier one stays', async () => {
    const world = await summaryWorld()
    await world.summaries.generate(world.matterId, { client: summaryClient() })
    await world.summaries.generate(world.matterId, { client: summaryClient() })
    expect(world.service.list(world.matterId, { kind: 'case_summary', subjectKey: 'ellery' }).map((artifact) => artifact.version)).toEqual([2, 1])
    expect(world.summaries.partiesView(world.matterId).parties.map((party) => [party.id, party.current, party.version])).toEqual([
      ['ellery', 'draft', 2], ['tamarack', null, undefined], ['greyvale', null, undefined],
    ])
  })
})

describe('case summaries: expert findings', () => {
  const expertContent = (world: Awaited<ReturnType<typeof summaryWorld>>, statement: string) => {
    const source = { evidenceId: world.evidenceId('12-expert-report-plaintiff-orthopaedic.txt'), paragraph: 1, quote: 'I have assumed that the patient had no left knee complaints before January 14, 2025.' }
    return {
      items: [{
        record: { id: 'expert-1', evidenceId: source.evidenceId, exhibitId: 'E-012', name: 'Dr. Renata Castellane', field: 'Orthopaedic surgery', identity: [source], qualificationsStated: false, qualifications: [], compensation: [], dataRelied: [], assumptions: [], opinions: [{ id: 'op-1', topic: 'future knee replacement', statement: 'A knee replacement within ten years.', assertion: 'expert_opinion', sources: [source] }] },
        indicators: [{ code: 'no_qualifications_stated', severity: 'concern', statement: 'The report states no qualification.', basis: [source] }],
        findings: [{ id: 'f-1', dimension: 'assumptions', polarity: 'negative', statement, basis: [source] }],
        readability: {}, assessment: { status: 'assessed' },
      }],
      comparisons: [], admissibility: { status: 'unknown', assessed: false, message: '', criteria: [] }, documents: { processed: [], failed: [] }, jurorImpact: null,
    }
  }

  it('passes approved expert findings to the model, reports them as available, and goes out of date when a newer assessment is approved', async () => {
    const world = await summaryWorld()
    const seed = (statement: string) => {
      const draft = world.service.saveDraft({ matterId: world.matterId, kind: 'expert_assessment', inputManifest: { evidenceHashes: [...world.byFile.values()].flatMap((item) => (item.sha256 ? [item.sha256] : [])) }, content: expertContent(world, statement) })
      return world.service.approve(world.matterId, draft.id)
    }
    // A draft assessment is not read: only approved ones are.
    world.service.saveDraft({ matterId: world.matterId, kind: 'expert_assessment', inputManifest: { evidenceHashes: [] }, content: expertContent(world, 'DRAFT_ONLY_FINDING') })
    const before = world.summaries.prerequisites(world.matterId, 'ellery')
    expect(before.items.find((item) => item.key === 'expert_assessment')!.status).toBe('missing')
    seed('The assumption about the left knee is stated without support.')
    const client = summaryClient()
    await world.summaries.generate(world.matterId, { client })
    const status = world.summaries.prerequisites(world.matterId, 'ellery').items.find((item) => item.key === 'expert_assessment')!
    expect(status).toMatchObject({ status: 'available', required: false, artifactVersion: 2 })
    const sent = client.calls[0].prompt.user
    expect(sent).toContain('The assumption about the left knee is stated without support.')
    expect(sent).toContain('The report states no qualification.')
    expect(sent).not.toContain('DRAFT_ONLY_FINDING')
    expect(world.summaries.view(world.matterId, 'ellery').draft!.freshness.status).toBe('current')
    seed('A second approved assessment.')
    expect(world.summaries.view(world.matterId, 'ellery').draft!.freshness.reasons).toEqual([expect.stringMatching(/newer approved expert assessment has replaced/)])
  })
})

describe('case summaries: law comes only from approved sources', () => {
  const hostile = (world: Awaited<ReturnType<typeof summaryWorld>>): ReplySentence[] => {
    const sources = [{ evidenceId: world.evidenceId('05-incident-report.txt'), paragraph: 1, quote: incidentQuote }]
    return [
      { section: 'facts', text: 'As held in Marshall v. Crestview Holdings, 1999 ONCA 123, and s. 42 of the Property Safety Act, the guard\'s note proves a breach.', sources },
      { section: 'precedent', text: 'This decision applies to the guard\'s note.', sources, authorityIds: ['invented:1'] },
      { section: 'expected_instructions', text: 'The jury will be told under section 42 of the Property Safety Act to find liability.', sources, authorityIds: ['instruction:civil-burden'] },
      { section: 'precedent', text: 'No approved case is named here.', sources },
    ]
  }

  it('rejects a case name and a statute the model invents, keeps them out of every accepted part, and shows them as refused', async () => {
    const world = await summaryWorld()
    const client = summaryClient({
      sentences: (_party, faithful) => [...faithful, ...hostile(world)],
      needsResearch: [{ section: 'precedent', topic: 'Whether Smith v. Jones, 2001 SCC 99 applies' }, { section: 'precedent', topic: 'Occupiers liability for ice on a walkway' }],
    })
    const [artifact] = await world.summaries.generate(world.matterId, { client })
    const accepted = JSON.stringify([artifact.content.items, artifact.content.authorities, artifact.content.needsResearch])
    for (const name of outsideNames) expect(accepted, name).not.toContain(name)
    // Visible: each refusal is in `rejected` with a reason.
    const reasons = artifact.rejected.map((entry) => entry.reason)
    expect(reasons).toEqual(expect.arrayContaining([
      expect.stringMatching(/names an authority that is not on the approved list \(.*Marshall v\. Crestview Holdings.*Property Safety Act/),
      expect.stringMatching(/relies on an authority that is not on the approved list/),
      expect.stringMatching(/section 42/),
      expect.stringMatching(/must apply an approved case/),
      expect.stringMatching(/research note names an authority/),
    ]))
    // The refused points show as "needs research" without naming the invented authority.
    expect(artifact.content.needsResearch.filter((note) => note.origin === 'code' && note.reason.includes('refused')).map((note) => note.section).sort()).toEqual(['expected_instructions', 'facts', 'precedent'])
    // The valid research note is kept and marked as the model's.
    expect(artifact.content.needsResearch.find((note) => note.topic === 'Occupiers liability for ice on a walkway')).toMatchObject({ origin: 'model' })
    // Control: the faithful sentences still pass.
    expect(artifact.content.items.length).toBeGreaterThan(5)
  })

  it('offers only the curated instruction sections when no court rules are chosen, and says precedent needs research', async () => {
    const world = await summaryWorld()
    const [artifact] = await world.summaries.generate(world.matterId, { client: summaryClient() })
    expect(artifact.content.authorities.map((authority) => [authority.kind, authority.origin])).toEqual([
      ['instruction', 'procedure_adapter'], ['instruction', 'procedure_adapter'], ['instruction', 'procedure_adapter'],
    ])
    expect(artifact.content.needsResearch.map((note) => note.topic)).toEqual(expect.arrayContaining(['Court rules', 'Precedent']))
    // The registry's criminal bail cases are not offered as civil precedent.
    expect(JSON.stringify(artifact.content.authorities)).not.toContain('Antic')
    // No precedent and no instruction sentence beyond what the faithful model could apply.
    expect(artifact.content.items.some((item) => item.section === 'precedent')).toBe(false)
    expect(artifact.content.items.some((item) => item.section === 'expected_instructions')).toBe(true)
  })

  it('takes authorities from the chosen unreviewed court rules, accepts a sentence that applies one, and flags the rules unreviewed', async () => {
    const world = await summaryWorld({ rules: true })
    const [artifact] = await world.summaries.generate(world.matterId, { client: summaryClient() })
    const kinds = artifact.content.authorities.map((authority) => authority.origin)
    expect(kinds).toEqual(expect.arrayContaining(['procedure_adapter', 'rule_pack']))
    expect(artifact.content.authorities.filter((authority) => authority.origin === 'rule_pack').every((authority) => authority.reviewStatus === 'unreviewed')).toBe(true)
    expect(artifact.content.authorities.find((authority) => authority.title.startsWith('Whiten v.'))).toMatchObject({ kind: 'case', ruleLabel: expect.stringContaining('Punitive'), toBeConfirmed: true })
    expect(artifact.content.courtRules).toMatchObject({ selected: true, unreviewed: true, notice: 'These rules have not been reviewed by a lawyer.' })
    // Valid control: a precedent sentence that applies an approved case is accepted.
    expect(artifact.content.items.find((item) => item.section === 'precedent')).toMatchObject({ authorityIds: [expect.stringMatching(/^pack:/)] })
    // The rules do not state damages caps, so that instruction is a research item.
    expect(artifact.content.needsResearch.map((note) => note.topic)).toEqual(expect.arrayContaining(['Damages caps']))
    // A sentence naming an approved statute and its pinpoint passes.
    const client = summaryClient({ sentences: (_party, faithful) => [...faithful, { section: 'facts', text: 'Under the Courts of Justice Act, s. 108(6), five of six jurors may answer a question.', sources: faithful[0].sources }] })
    const [second] = await world.summaries.generate(world.matterId, { client })
    expect(second.content.items.some((item) => item.text.includes('s. 108(6)'))).toBe(true)
  })

  it('lets a fact sentence name a statute that its own cited quotation names', async () => {
    const world = await summaryWorld()
    const client = summaryClient({
      sentences: (_party, faithful) => [...faithful, { section: 'facts', text: 'The Plaintiff pleads that Tamarack breached the Occupiers\' Liability Act.', sources: [{ evidenceId: world.evidenceId('01-statement-of-claim.txt'), paragraph: 1, quote: claimQuote }] }],
    })
    const [artifact] = await world.summaries.generate(world.matterId, { client })
    expect(artifact.content.items.some((item) => item.text.includes('Occupiers\' Liability Act'))).toBe(true)
    expect(artifact.rejected).toEqual([])
  })
})

describe('case summaries: approval and freshness', () => {
  it('approves a draft, serves it to its own party only, and calls it out of date when an upstream approval is replaced', async () => {
    const world = await summaryWorld()
    await world.summaries.generate(world.matterId, { client: summaryClient() })
    const view = world.summaries.view(world.matterId, 'ellery')
    expect(view.draft!.approval).toEqual({ canApprove: true, blockers: [] })
    expect(view.draft!.counts.sentences).toBeGreaterThan(5)
    expect(view.draft!.sections.map((section) => section.key)).toEqual(['theory', 'facts', 'claims_elements', 'expected_instructions', 'precedent', 'witness_credibility', 'weaknesses', 'verdict_walk'])
    const approved = world.summaries.approve(world.matterId, 'ellery')
    expect(approved).toMatchObject({ status: 'approved', subjectKey: 'ellery' })
    expect(world.service.approvedFor({ role: 'party', partyId: 'ellery' }, world.matterId, 'case_summary')).toHaveLength(1)
    expect(world.service.approvedFor({ role: 'party', partyId: 'tamarack' }, world.matterId, 'case_summary')).toEqual([])
    expect(world.service.approvedFor(owner, world.matterId, 'case_summary')).toHaveLength(1)
    expect(() => world.summaries.approve(world.matterId, 'tamarack')).toThrow(/no draft summary/)
  })

  it('refuses to approve when nothing passed the checks, and when a newer approved case map replaced the one used', async () => {
    const world = await summaryWorld()
    await world.summaries.generate(world.matterId, { client: summaryClient({ sentences: () => [{ section: 'facts', text: 'Uncited.', sources: [] }] }) })
    expect(world.summaries.view(world.matterId, 'ellery').draft!.approval.blockers).toEqual([expect.stringMatching(/No sentence passed the checks/)])
    expect(() => world.summaries.approve(world.matterId, 'ellery')).toThrow(/cannot be approved yet/)

    await world.summaries.generate(world.matterId, { client: summaryClient() })
    // A new approved case map: the summary was made from the earlier one.
    await world.caseMap.generate(world.matterId, { client: (await import('./caseMapFixtures')).scripted(world) })
    world.caseMap.approve(world.matterId)
    const view = world.summaries.view(world.matterId, 'ellery').draft!
    expect(view.freshness.status).toBe('out_of_date')
    expect(view.freshness.reasons).toEqual([expect.stringMatching(/newer approved case map has replaced/)])
    expect(view.approval.canApprove).toBe(false)
    expect(() => world.summaries.approve(world.matterId, 'ellery')).toThrow(/out of date/)
  })
})
