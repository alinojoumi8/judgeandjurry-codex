import { afterEach, describe, expect, it } from 'vitest'

import { AnalysisService } from '../server/analysis/service'
import { ScriptedCourtroomModel, createCourtroomFixture } from '../samples/courtroom-realism/fixture'
import { cleanupAnalysisFixtures, fileStore, rawDb, trackStore } from './analysisFixtures'

afterEach(cleanupAnalysisFixtures)

const CANARY = 'ANALYSIS_CANARY_PHRASE_5f3b9c1e'

function dump(path: string, table: string): string {
  const db = rawDb(path)
  try { return JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all()) } finally { db.close() }
}

describe('standing canary: approved analysis never reaches simulated participants', () => {
  it('keeps an approved owner artifact out of juror and witness requests and out of run records', async () => {
    const { path } = fileStore()
    const client = new ScriptedCourtroomModel()
    const f = createCourtroomFixture(client, path)
    trackStore(f.store)
    const service = new AnalysisService(f.store)

    const saved = service.saveDraft({
      matterId: f.matter.id, kind: 'case_summary', audience: 'party', subjectKey: 'crown', caseModelId: f.model.id,
      inputManifest: { evidenceHashes: [], caseModelVersion: f.model.version },
      content: { summary: `Private preparation. ${CANARY}` },
    })
    service.approve(f.matter.id, saved.id)
    expect(service.approvedFor({ role: 'owner' }, f.matter.id)).toHaveLength(1)
    expect(service.approvedFor({ role: 'party', partyId: 'crown' }, f.matter.id)).toHaveLength(1)

    await f.engine.runAutonomous(f.run.id)
    f.engine.command(f.run.id, { type: 'approve_checkpoint' })
    await f.engine.runAutonomous(f.run.id)

    // Positive control: the capture really saw juror and witness requests.
    const jurorRequests = client.requests.filter((request) => request.stage === 'juror_ballot')
    const witnessRequests = client.requests.filter((request) => request.stage === 'witness_answer')
    expect(jurorRequests.length).toBeGreaterThan(0)
    expect(jurorRequests.every((request) => (request.jurorProfiles?.length ?? 0) > 0)).toBe(true)
    expect(witnessRequests.length).toBeGreaterThan(0)

    expect(JSON.stringify(client.requests)).not.toContain(CANARY)
    for (const table of ['trial_events', 'actor_snapshots', 'actor_context_inputs']) {
      const rows = dump(path, table)
      // Positive control for the scan itself: these tables are not empty.
      expect(rows.length, table).toBeGreaterThan(2)
      expect(rows, table).not.toContain(CANARY)
    }
    // The scan can see the canary where it legitimately lives.
    expect(dump(path, 'analysis_artifacts')).toContain(CANARY)
  }, 60_000)
})
