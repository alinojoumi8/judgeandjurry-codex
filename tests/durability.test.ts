import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { CaseStore } from '../server/db'

let stores: CaseStore[] = []
let tempDirs: string[] = []

afterEach(() => {
  for (const store of stores) {
    try {
      store.close()
    } catch {
      // already closed
    }
  }
  stores = []
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true })
  }
  tempDirs = []
})

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'judge-jury-db-'))
  tempDirs.push(dir)
  return join(dir, 'test.sqlite')
}

describe('store durability', () => {
  it('fails orphaned running sessions when the store reopens so they can resume', () => {
    const dbPath = tempDbPath()
    const first = new CaseStore(dbPath)
    stores.push(first)
    const matter = first.createMatter({
      title: 'Orphan Matter',
      narrative: 'The server died mid-run.',
    })
    const session = first.createSession(matter.id)
    first.markStageRunning(session.id, 'intake_normalization')
    expect(first.getSessionDetails(session.id).status).toBe('running')
    first.close()

    // Simulates a process restart: the same database file is reopened.
    const second = new CaseStore(dbPath)
    stores.push(second)
    const recovered = second.getSessionDetails(session.id)

    expect(recovered.status).toBe('failed')
    const intakeStage = recovered.stages.find(
      (stage) => stage.stage === 'intake_normalization',
    )
    expect(intakeStage?.status).toBe('failed')
    expect(intakeStage?.error).toContain('restarted')

    // And the failed session is resumable again.
    const resumed = second.resumeSession(session.id)
    expect(resumed.status).toBe('running')
  })

  it('keeps turn order stable when a stage is re-run after deletions', () => {
    const store = new CaseStore(':memory:')
    stores.push(store)
    const matter = store.createMatter({
      title: 'Index Matter',
      narrative: 'Order indexes must not collide.',
    })
    const session = store.createSession(matter.id)

    store.appendTurn(session.id, {
      stage: 'intake_normalization',
      role: 'analyst',
      title: 'Intake',
      content: 'First.',
      citations: [],
    })
    store.appendTurn(session.id, {
      stage: 'issue_spotting',
      role: 'judge',
      title: 'Issues',
      content: 'Second.',
      citations: [],
    })
    store.appendTurn(session.id, {
      stage: 'crown_opening',
      role: 'crown',
      title: 'Crown',
      content: 'Third.',
      citations: [],
    })

    // Re-running an earlier stage deletes its turn; the replacement must sort
    // after the surviving turns instead of colliding with an existing index.
    store.markStageRunning(session.id, 'issue_spotting')
    store.appendTurn(session.id, {
      stage: 'issue_spotting',
      role: 'judge',
      title: 'Issues Retry',
      content: 'Second again.',
      citations: [],
    })

    const turns = store.getSessionDetails(session.id).turns
    const indexes = turns.map((turn) => turn.orderIndex)
    expect(new Set(indexes).size).toBe(indexes.length)
    expect(turns.at(-1)?.title).toBe('Issues Retry')
  })

  it('clears prior jury opinions when the jury stage re-runs', () => {
    const store = new CaseStore(':memory:')
    stores.push(store)
    const matter = store.createMatter({
      title: 'Jury Rerun Matter',
      narrative: 'Jury opinions must not duplicate.',
    })
    const session = store.createSession(matter.id, { jurorCount: 2 })

    store.addJuryOpinion(session.id, {
      juror: 'Juror 1',
      leaning: 'crown',
      confidence: 70,
      rationale: 'First pass.',
      citations: [],
      beliefTrail: [],
      deliberationRounds: [],
      mindChangedBecause: 'n/a',
      consistencyWarnings: [],
    })

    store.markStageRunning(session.id, 'jury_deliberation')
    expect(store.getSessionDetails(session.id).juryOpinions).toHaveLength(0)
  })
})
