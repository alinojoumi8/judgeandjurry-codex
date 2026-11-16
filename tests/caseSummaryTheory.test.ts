import { afterEach, describe, expect, it } from 'vitest'

import { cleanupAnalysisFixtures, addSource } from './analysisFixtures'
import { canaries, summaryClient, summaryWorld } from './caseSummaryFixtures'

afterEach(cleanupAnalysisFixtures)

const briefsOf = (world: Awaited<ReturnType<typeof summaryWorld>>, modelId: string) => world.store.workflow.listTheoryBriefs(modelId)

describe('case summaries: use as theory', () => {
  it('changes nothing until the user asks, then saves a new draft case model version with the theory and leaves the old one alone', async () => {
    const world = await summaryWorld()
    const briefsBefore = JSON.stringify(briefsOf(world, world.model.id))
    const modelsBefore = world.workflow.listCaseModels(world.matterId)
    await world.summaries.generate(world.matterId, { client: summaryClient() })
    // Generation alone affects nothing, and neither does approval.
    expect(() => world.summaries.useAsTheoryPreview(world.matterId, 'ellery')).toThrow(/Approve this summary before using it as a theory/)
    world.summaries.approve(world.matterId, 'ellery')
    expect(JSON.stringify(briefsOf(world, world.model.id))).toBe(briefsBefore)
    expect(world.workflow.listCaseModels(world.matterId)).toEqual(modelsBefore)

    // The preview says what will be replaced and what it creates, and still changes nothing.
    const preview = world.summaries.useAsTheoryPreview(world.matterId, 'ellery')
    expect(preview.base).toMatchObject({ caseModelId: world.model.id, version: 1, status: 'approved' })
    expect(preview.nextVersion).toBe(2)
    expect(preview.replaces).toMatchObject({ narrative: expect.stringContaining(canaries.ellery), sourceKind: 'user' })
    expect(preview.newNarrative).toMatch(/^Theory of the case, from a model-generated summary \(version 1\)/)
    expect(preview.newNarrative).toContain('Jordan Ellery says the walkway was left in an unsafe state. [E-005 para. 1]')
    expect(preview.notes.join(' ')).toMatch(/Version 1 is not edited/)
    expect(world.workflow.listCaseModels(world.matterId)).toEqual(modelsBefore)

    const result = world.summaries.useAsTheory(world.matterId, 'ellery')
    expect(result.caseModel).toMatchObject({ version: 2, status: 'draft' })
    expect(result.replacedBriefId).toBe(preview.replaces!.briefId)
    const models = world.workflow.listCaseModels(world.matterId)
    expect(models.map((model) => [model.version, model.status])).toEqual([[2, 'draft'], [1, 'approved']])
    // The approved version and its theory are exactly as they were.
    expect(JSON.stringify(briefsOf(world, world.model.id))).toBe(briefsBefore)
    expect(models.find((model) => model.id === world.model.id)).toEqual(world.model)
    // The new version has one theory for this side, with the summary's text; the other sides' theories are copied unchanged.
    const next = briefsOf(world, result.caseModel.id)
    expect(next.filter((brief) => brief.partyId === 'ellery')).toHaveLength(1)
    expect(next.find((brief) => brief.partyId === 'ellery')).toMatchObject({ narrative: preview.newNarrative, sourceKind: 'model', visibility: 'private', title: preview.newTitle })
    expect(next.find((brief) => brief.partyId === 'ellery')!.narrative).not.toContain(canaries.ellery)
    expect(next.find((brief) => brief.partyId === 'tamarack')!.narrative).toContain(canaries.tamarack)
    expect(next.find((brief) => brief.partyId === 'greyvale')!.narrative).toContain(canaries.greyvale)
    // The use is recorded as a new approved version of the summary, and cannot be repeated for it.
    const approved = world.summaries.view(world.matterId, 'ellery').approved!
    expect(approved.content.usedAsTheory).toMatchObject({ caseModelId: result.caseModel.id, caseModelVersion: 2, briefId: result.brief.id, replacedBriefId: preview.replaces!.briefId })
    expect(() => world.summaries.useAsTheory(world.matterId, 'ellery')).toThrow(/already used as a theory/)
    expect(world.workflow.listCaseModels(world.matterId)).toHaveLength(2)
  })

  it('never puts the other side\'s theory or summary into the theory it saves', async () => {
    const world = await summaryWorld()
    await world.summaries.generate(world.matterId, { client: summaryClient(), partyIds: ['ellery', 'tamarack'] })
    world.summaries.approve(world.matterId, 'tamarack')
    const result = world.summaries.useAsTheory(world.matterId, 'tamarack')
    const saved = JSON.stringify(result.brief)
    expect(saved).toContain('Tamarack Quay Holdings Inc. says')
    expect(saved).not.toContain(canaries.ellery)
    expect(saved).not.toContain('Jordan Ellery says')
  })

  it('creates the theory for a side that had none, and refuses a summary with no theory sentence or an out-of-date one', async () => {
    const world = await summaryWorld({ theories: false })
    await world.summaries.generate(world.matterId, { client: summaryClient() })
    world.summaries.approve(world.matterId, 'ellery')
    const preview = world.summaries.useAsTheoryPreview(world.matterId, 'ellery')
    expect(preview.replaces).toBeNull()
    expect(preview.notes[0]).toMatch(/keeps having no theory/)
    const result = world.summaries.useAsTheory(world.matterId, 'ellery')
    expect(briefsOf(world, result.caseModel.id).filter((brief) => brief.partyId === 'ellery')).toHaveLength(1)
    expect(briefsOf(world, world.model.id)).toEqual([])

    // A summary whose theory section is empty has nothing to use.
    await world.summaries.generate(world.matterId, { client: summaryClient({ sentences: (_party, faithful) => faithful.filter((sentence) => sentence.section !== 'theory') }) })
    world.summaries.approve(world.matterId, 'ellery')
    expect(() => world.summaries.useAsTheoryPreview(world.matterId, 'ellery')).toThrow(/no theory-of-the-case sentence/)
  })

  it('refuses to use a summary that has gone out of date', async () => {
    const world = await summaryWorld()
    await world.summaries.generate(world.matterId, { client: summaryClient() })
    world.summaries.approve(world.matterId, 'ellery')
    addSource(world.store, world.matterId, 'new-document.txt', 'A document added after the summary was approved.')
    expect(() => world.summaries.useAsTheoryPreview(world.matterId, 'ellery')).toThrow(/out of date and cannot become a theory/)
  })
})

describe('case summaries: export', () => {
  it('writes Markdown with the labels, what was available, citations resolved to exhibit and paragraph, and the unreviewed-rules notice', async () => {
    const world = await summaryWorld({ rules: true })
    await world.summaries.generate(world.matterId, { client: summaryClient({ needsResearch: [{ section: 'precedent', topic: 'Occupiers liability for ice on a walkway' }] }) })
    const report = world.summaries.exportReport(world.matterId, 'ellery')
    const md = report.markdown
    expect(report.filename).toBe('ellery-v.-tamarack-quay-holdings-inc.-and-greyvale-grounds-ltd.-jordan-ellery-summary-v1.md')
    expect(md).toMatch(/^# Case summary for Jordan Ellery \(plaintiff\): Ellery v\. Tamarack/)
    expect(md).toContain('Status: Draft version 1 (not approved)')
    expect(md).toContain('Private preparation for Jordan Ellery only.')
    expect(md).toMatch(/Model-generated draft\. A model wrote every sentence\./)
    expect(md).toContain('not a prediction')
    expect(md).toContain('Simulated panels and ballots are not real verdict probabilities')
    expect(md).toContain('Unreviewed court rules: These rules have not been reviewed by a lawyer.')
    expect(md).toContain('- Approved case map: available.')
    expect(md).toContain('- Approved expert assessment: MISSING. 3 expert reports are in the record but there is no approved expert assessment.')
    for (const heading of ['Theory of the case', 'Facts, with citations', 'Claims and elements, with the burden', 'Expected instructions', 'Precedent', 'Witness credibility', 'Acknowledged weaknesses', 'Walk through the verdict form']) {
      expect(md).toContain(`## ${heading}`)
    }
    // Citations resolve to exhibit and paragraph, and the quotation is listed.
    expect(md).toContain('The guard recorded glare ice and no visible salt at the east entrance [E-005, para. 1]')
    expect(md).toContain('- E-005 (05-incident-report.txt), para. 1: "Walkway at east entrance: glare ice, no visible salt."')
    expect(md).toContain('- Needs research: Occupiers liability for ice on a walkway.')
    // Approved authorities are listed with their source, and unreviewed ones say so.
    expect(md).toMatch(/Whiten v\. Pilot Insurance Co\., 2002 SCC 18 \(punitive damages.*\| supports: Punitive damages available.*proposition to be confirmed by a reviewer \| not reviewed by a lawyer/)
    expect(md).toMatch(/### Question 1: /)
    expect(report.html).toContain('<title>Case summary for Jordan Ellery - TrialLens case summary</title>')
    expect(report.html).toContain('<h2>Facts, with citations</h2>')
  })

  it('says so when no court rules are chosen and when a summary is out of date, and labels an approved version', async () => {
    const world = await summaryWorld()
    await world.summaries.generate(world.matterId, { client: summaryClient() })
    expect(world.summaries.exportReport(world.matterId, 'ellery').markdown).toContain('No court rules were chosen for this case when this summary was made.')
    world.summaries.approve(world.matterId, 'ellery')
    const approved = world.summaries.exportReport(world.matterId, 'ellery', 'approved').markdown
    expect(approved).toContain('Status: Approved version 1 (a person approved it)')
    expect(() => world.summaries.exportReport(world.matterId, 'ellery', 'draft')).toThrow(/no draft summary/)
    expect(() => world.summaries.exportReport(world.matterId, 'tamarack')).toThrow(/no summary for this side/)
    addSource(world.store, world.matterId, 'later.txt', 'Added later.')
    expect(world.summaries.exportReport(world.matterId, 'ellery').markdown).toMatch(/- Out of date: .*added to this matter/)
  })

  it('escapes HTML in a quotation and a model sentence, and a sentence cannot start a heading', async () => {
    const world = await summaryWorld()
    const injected = addSource(world.store, world.matterId, 'notes.txt', '<script>alert("x")</script> The tenant paid rent on time.')
    const client = summaryClient({
      sentences: (_party, faithful) => [
        ...faithful,
        { section: 'facts', text: 'The note holds a script <img src=x onerror=alert(1)> and says rent was paid.', sources: [{ evidenceId: injected.id, paragraph: 1, quote: '<script>alert("x")</script> The tenant' }] },
        { section: 'weaknesses', text: '## Injected heading\nwith a second line', sources: [{ evidenceId: injected.id, paragraph: 1, quote: 'The tenant paid rent on time' }] },
      ],
    })
    await world.summaries.generate(world.matterId, { client })
    const { markdown, html } = world.summaries.exportReport(world.matterId, 'ellery')
    // Positive control: the quotation really is in the report, so the escape is what is being tested.
    expect(markdown).toContain('"<script>alert("x")</script> The tenant"')
    expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; The tenant')
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(html).not.toMatch(/<script/i)
    expect(html).not.toMatch(/<img/i)
    expect(html).not.toContain('<h2>## Injected')
    expect(html).not.toContain('<h2>Injected heading')
    // Every dynamic string is one line, so the sentence's line break did not make a line of its own.
    expect(markdown).toContain('- ## Injected heading with a second line [')
  })
})
