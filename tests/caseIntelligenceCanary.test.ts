import { afterEach, describe, expect, it } from 'vitest'

import { ChronologyService } from '../server/analysis/chronology'
import { EvidenceIndexService } from '../server/analysis/evidenceIndex'
import { ExpertAssessmentService } from '../server/analysis/expertAssessment'
import { AnalysisService } from '../server/analysis/service'
import { CaseWorkflowService } from '../server/caseWorkflow'
import { ScriptedCourtroomModel, createCourtroomFixture } from '../samples/courtroom-realism/fixture'
import { cleanupAnalysisFixtures, fileStore, rawDb, trackStore } from './analysisFixtures'
import { routedClient, type Router } from './intelligenceFixtures'

afterEach(cleanupAnalysisFixtures)

const CANARY = 'INTELLIGENCE_CANARY_PHRASE_8a41d7c0'
const noticeText = 'Early material fact: notice was delivered.'

function dump(path: string, table: string): string {
  const db = rawDb(path)
  try { return JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all()) } finally { db.close() }
}

// Plan section 8 standing check: juror and witness context contains no canary
// phrase from any analysis artifact. This one covers the three M3 artifact
// kinds, each approved and each carrying the canary in model-written text.
describe('standing canary for chronology, evidence index, expert assessment and readings', () => {
  it('keeps approved M3 artifacts out of juror and witness requests and out of run records', async () => {
    const { path } = fileStore()
    const client = new ScriptedCourtroomModel()
    const f = createCourtroomFixture(client, path)
    trackStore(f.store)
    const analysis = new AnalysisService(f.store)
    const workflow = new CaseWorkflowService(f.store)
    const noticeId = f.evidence.exhibitId
    const src = { evidenceId: noticeId, paragraph: 1, quote: 'notice was delivered' }

    const router: Router = (request) => {
      if (!request.inputs[0].id.startsWith(noticeId)) {
        // The excluded source: nothing is extracted from it.
        return request.task === 'chronology_extraction' ? { events: [] } : request.task === 'evidence_index_extraction' ? { entries: [] } : { experts: [] }
      }
      switch (request.task) {
        case 'chronology_extraction':
          return { events: [{ when: { precision: 'unknown', original: '' }, description: `Notice delivered. ${CANARY}`, type: 'communication', assertion: 'record', sources: [src], issueIds: [] }] }
        case 'chronology_readings':
          return { readings: [
            { lens: 'plain_language', text: `Plain. ${CANARY}` }, { lens: 'likely_question', text: `Question. ${CANARY}` }, { lens: 'which_way_it_cuts', text: `Cuts. ${CANARY}`, cutsToward: 'unclear' },
          ] }
        case 'evidence_index_extraction':
          return { entries: [{ type: 'allegation', summary: `Alleged notice. ${CANARY}`, sources: [src], issueIds: [] }], gaps: [{ description: `Gap. ${CANARY}`, sources: [src] }] }
        case 'expert_record_extraction':
          return { experts: [{ name: `Dr. ${CANARY}`, field: 'f', identity: [src], opinions: [{ topic: 'notice', statement: `Opinion ${CANARY}`, sources: [src] }] }] }
        case 'expert_assessment':
          return { findings: [{ dimension: 'method', polarity: 'neutral', statement: `Finding ${CANARY}`, basis: [src] }] }
        default:
          throw new Error(`Unexpected task ${request.task}`)
      }
    }
    const structured = routedClient(router, 12)

    const chronology = new ChronologyService(f.store, analysis, workflow)
    const first = await chronology.generate(f.matter.id, { client: structured })
    const eventId = (first.content as { items: Array<{ id: string }> }).items[0].id
    chronology.review(f.matter.id, eventId, { action: 'accept' })
    chronology.approve(f.matter.id)
    await chronology.generateReadings(f.matter.id, { client: structured })
    chronology.approve(f.matter.id)

    const index = new EvidenceIndexService(f.store, analysis, workflow)
    await index.generate(f.matter.id, { client: structured })
    index.approve(f.matter.id)

    const experts = new ExpertAssessmentService(f.store, analysis)
    await experts.generate(f.matter.id, { client: structured, evidenceIds: [f.evidence.id] })
    experts.approve(f.matter.id)

    // The artifacts exist, are approved, and really carry the canary.
    const approved = analysis.approvedFor({ role: 'owner' }, f.matter.id)
    expect(approved.map((artifact) => artifact.kind).sort()).toEqual(['chronology', 'evidence_index', 'expert_assessment'])
    for (const artifact of approved) expect(JSON.stringify(artifact.content), artifact.kind).toContain(CANARY)
    // Positive control: readings were really produced from the admitted (limited) source and not the excluded one.
    const readings = chronology.views(f.matter.id).approved?.content.readings
    expect(readings?.items).toHaveLength(1)

    await f.engine.runAutonomous(f.run.id)
    f.engine.command(f.run.id, { type: 'approve_checkpoint' })
    await f.engine.runAutonomous(f.run.id)

    const jurorRequests = client.requests.filter((request) => request.stage === 'juror_ballot')
    const witnessRequests = client.requests.filter((request) => request.stage === 'witness_answer')
    expect(jurorRequests.length).toBeGreaterThan(0)
    expect(witnessRequests.length).toBeGreaterThan(0)
    expect(JSON.stringify(client.requests)).not.toContain(CANARY)
    for (const table of ['trial_events', 'actor_snapshots', 'actor_context_inputs']) {
      const rows = dump(path, table)
      expect(rows.length, table).toBeGreaterThan(2)
      expect(rows, table).not.toContain(CANARY)
    }
    expect(dump(path, 'analysis_artifacts')).toContain(CANARY)
    // The readings never saw the excluded source either.
    const readingRequests = structured.calls.filter((call) => call.request.task === 'chronology_readings')
    expect(readingRequests).toHaveLength(1)
    expect(JSON.stringify(readingRequests.map((call) => call.request))).not.toContain('OTHER_WITNESS_527')
    expect(readingRequests[0].request.inputs[0].text).toBe(noticeText)
  }, 60_000)
})
