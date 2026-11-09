import { afterEach, describe, expect, it } from 'vitest'

import { CaseSummaryService } from '../server/analysis/caseSummary'
import type { CaseMapContent } from '../server/analysis/caseMapTypes'
import type { ChronologyEvent } from '../server/analysis/chronology'
import type { ExtractedEntry } from '../server/analysis/evidenceIndex'
import { AnalysisService } from '../server/analysis/service'
import { CaseWorkflowService } from '../server/caseWorkflow'
import { FrameworkService } from '../server/frameworks/service'
import { ScriptedCourtroomModel, createCourtroomFixture } from '../samples/courtroom-realism/fixture'
import { cleanupAnalysisFixtures, fileStore, rawDb, trackStore } from './analysisFixtures'
import { summaryClient } from './caseSummaryFixtures'

afterEach(cleanupAnalysisFixtures)

const SUMMARY_CANARY = { crown: 'SUMMARY_CANARY_CROWN_2e90bd', accused: 'SUMMARY_CANARY_ACCUSED_6a13c7' }

function dump(path: string, table: string): string {
  const db = rawDb(path)
  try { return JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all()) } finally { db.close() }
}

// Plan section 8 standing check for F6: a canary phrase in an approved case
// summary, for either side, never reaches a juror or witness request or any run
// record, and generating or approving a summary changes no theory.
describe('standing canary for case summaries', () => {
  it('keeps approved summaries of both sides out of juror and witness requests and out of run records', async () => {
    const { path } = fileStore()
    const model = new ScriptedCourtroomModel()
    const f = createCourtroomFixture(model, path)
    trackStore(f.store)
    const analysis = new AnalysisService(f.store)
    const workflow = new CaseWorkflowService(f.store)
    const quote = 'notice was delivered'
    const source = { evidenceId: f.evidence.id, paragraph: 1, quote }

    // The prerequisites, approved. Seeded directly: this test is about what a summary can reach, not how they are made.
    const chronology = analysis.saveSourcedDraft<ChronologyEvent>({
      matterId: f.matter.id, kind: 'chronology', inputManifest: { evidenceHashes: [] },
      items: [{ id: 'ev-1', when: { precision: 'unknown', original: '' }, description: 'Notice was delivered', type: 'communication', assertion: 'record', sources: [source], issueIds: [], conflictsWith: [], review: 'accepted', warnings: [] }],
      extraContent: { conflicts: [], candidateDates: [], documents: { processed: [], failed: [] }, reviewLog: [] },
    })
    analysis.approve(f.matter.id, chronology.id)
    const index = analysis.saveSourcedDraft<ExtractedEntry>({
      matterId: f.matter.id, kind: 'evidence_index', inputManifest: { evidenceHashes: [] },
      items: [{ id: 'ix-001', type: 'testimony', summary: 'A witness says notice was delivered', speaker: 'A witness', examinationType: 'direct', sources: [source], issueIds: [], warnings: [] }],
      extraContent: { suggestions: [], gaps: [], documents: { processed: [], failed: [] }, reviewLog: [] },
    })
    analysis.approve(f.matter.id, index.id)
    const issue = f.model.decisionIssues[0]
    const mapContent: CaseMapContent = {
      items: [], parties: f.model.parties.map((party) => ({ id: party.id, name: party.name, role: party.role, proposed: false, sources: [] })),
      issues: [{
        key: issue.id, itemId: 'item-1', kind: issue.kind, label: issue.label, questionText: issue.label, claimantPartyId: issue.claimantPartyId, respondingPartyIds: issue.respondingPartyIds,
        elements: issue.elements.map((element) => ({ id: element.id, label: 'The notice was delivered', burden: element.burden, origin: 'case_model' as const, inferred: false, placeholder: false })),
        permittedOutcomes: issue.permittedOutcomes, answerType: 'choice', dependsOn: [], order: 0, included: true, sources: [], warnings: [],
      }],
      documents: { processed: [], failed: [] }, elementSuggestion: { status: 'not_needed', suggested: 0 },
      framework: { selected: false, reviewed: false, judgeOnlyKinds: [], juryAvailabilityKnown: false }, reviewLog: [],
    }
    const map = analysis.saveDraft<CaseMapContent>({ matterId: f.matter.id, kind: 'case_map', caseModelId: f.model.id, inputManifest: { evidenceHashes: [] }, content: mapContent })
    analysis.approve(f.matter.id, map.id)

    const summaries = new CaseSummaryService(f.store, analysis, workflow, new FrameworkService(f.store))
    const partyIds = f.model.parties.map((party) => party.id)
    expect(partyIds).toEqual(expect.arrayContaining(['crown', 'accused-1']))
    const theoriesBefore = JSON.stringify(f.store.workflow.listTheoryBriefs(f.model.id))
    const modelsBefore = f.store.workflow.listCaseModels(f.matter.id).length

    const structured = summaryClient({
      sentences: (partyId, faithful) => [...faithful, { section: 'weaknesses', text: `Private weakness note. ${partyId === 'crown' ? SUMMARY_CANARY.crown : SUMMARY_CANARY.accused}`, sources: faithful[0].sources }],
    })
    await summaries.generate(f.matter.id, { client: structured, partyIds: ['crown', 'accused-1'] })
    summaries.approve(f.matter.id, 'crown')
    summaries.approve(f.matter.id, 'accused-1')

    // Generating and approving changed no theory and made no case model version.
    expect(JSON.stringify(f.store.workflow.listTheoryBriefs(f.model.id))).toBe(theoriesBefore)
    expect(f.store.workflow.listCaseModels(f.matter.id)).toHaveLength(modelsBefore)
    // Each summary is approved, private to its side, and really carries its canary.
    const crown = analysis.approvedFor({ role: 'party', partyId: 'crown' }, f.matter.id, 'case_summary')
    const accused = analysis.approvedFor({ role: 'party', partyId: 'accused-1' }, f.matter.id, 'case_summary')
    expect(crown).toHaveLength(1)
    expect(accused).toHaveLength(1)
    expect(JSON.stringify(crown[0].content)).toContain(SUMMARY_CANARY.crown)
    expect(JSON.stringify(crown[0].content)).not.toContain(SUMMARY_CANARY.accused)
    expect(JSON.stringify(accused[0].content)).toContain(SUMMARY_CANARY.accused)
    expect(JSON.stringify(accused[0].content)).not.toContain(SUMMARY_CANARY.crown)

    await f.engine.runAutonomous(f.run.id)
    f.engine.command(f.run.id, { type: 'approve_checkpoint' })
    await f.engine.runAutonomous(f.run.id)

    // Positive control: the capture really saw juror and witness requests.
    expect(model.requests.filter((request) => request.stage === 'juror_ballot').length).toBeGreaterThan(0)
    expect(model.requests.filter((request) => request.stage === 'witness_answer').length).toBeGreaterThan(0)
    const everything = JSON.stringify(model.requests)
    for (const canary of Object.values(SUMMARY_CANARY)) expect(everything).not.toContain(canary)
    for (const table of ['trial_events', 'actor_snapshots', 'actor_context_inputs']) {
      const rows = dump(path, table)
      expect(rows.length, table).toBeGreaterThan(2)
      for (const canary of Object.values(SUMMARY_CANARY)) expect(rows, table).not.toContain(canary)
    }
    expect(dump(path, 'analysis_artifacts')).toContain(SUMMARY_CANARY.crown)
  }, 60_000)
})
