import { describe, expect, it } from 'vitest'

import { CaseWorkflowService } from '../server/caseWorkflow'
import type { StageRequest } from '../server/minimax'
import { newestTheoryBrief } from '../server/trialEngine'
import type { TheoryBrief } from '../server/trialEngineTypes'
import { createCourtroomFixture } from '../samples/courtroom-realism/fixture'

const brief = (id: string, partyId: string, createdAt: string, updatedAt = createdAt): TheoryBrief => ({
  id, matterId: 'm', caseModelId: 'cm', partyId, side: 'crown', title: id, narrative: id, claims: [], visibility: 'private', sourceKind: 'user', createdAt, updatedAt,
})

describe('newestTheoryBrief', () => {
  it('picks the most recently updated brief of the party, not the oldest', () => {
    const briefs = [brief('old', 'crown', '2026-01-01T00:00:00.000Z'), brief('new', 'crown', '2026-02-01T00:00:00.000Z'), brief('other', 'accused-1', '2026-03-01T00:00:00.000Z')]
    expect(newestTheoryBrief(briefs, 'crown')?.id).toBe('new')
    expect(newestTheoryBrief(briefs, 'accused-1')?.id).toBe('other')
    expect(newestTheoryBrief(briefs, 'nobody')).toBeUndefined()
  })

  it('counts a re-save of an old brief (same id, later updatedAt) as the newest', () => {
    const briefs = [brief('first', 'crown', '2026-01-01T00:00:00.000Z', '2026-04-01T00:00:00.000Z'), brief('second', 'crown', '2026-02-01T00:00:00.000Z')]
    expect(newestTheoryBrief(briefs, 'crown')?.id).toBe('first')
  })

  it('falls back to createdAt when updatedAt is missing, and lets the later-stored brief win a tie', () => {
    const legacy = { ...brief('legacy', 'crown', '2026-05-01T00:00:00.000Z'), updatedAt: '' }
    expect(newestTheoryBrief([brief('earlier', 'crown', '2026-01-01T00:00:00.000Z'), legacy], 'crown')?.id).toBe('legacy')
    expect(newestTheoryBrief([legacy, brief('earlier', 'crown', '2026-01-01T00:00:00.000Z')], 'crown')?.id).toBe('legacy')
    const tie = '2026-06-01T00:00:00.000Z'
    expect(newestTheoryBrief([brief('a', 'crown', tie), brief('b', 'crown', tie)], 'crown')?.id).toBe('b')
  })

  it('returns the only brief unchanged', () => {
    const only = brief('only', 'crown', '2026-01-01T00:00:00.000Z')
    expect(newestTheoryBrief([only], 'crown')).toBe(only)
  })
})

describe('the advocate argues from the newest brief', () => {
  // Captures every request the engine makes up to the first advocacy request, then stops the run.
  const captureAdvocacy = async (extraCrownNarrative?: string) => {
    const requests: StageRequest[] = []
    const f = createCourtroomFixture({
      async generateStage(request) { requests.push(request); throw new Error('capture') },
    })
    if (extraCrownNarrative) new CaseWorkflowService(f.store).saveTheoryBrief({ caseModelId: f.model.id, partyId: 'crown', side: 'crown', narrative: extraCrownNarrative })
    try { await f.engine.runAutonomous(f.run.id) } catch { /* capture */ }
    f.store.close()
    return requests.find((request) => request.packet.includes('Private theory for this advocate only'))?.packet ?? ''
  }

  it('uses the brief saved last when a party has two (the re-saved brief replaces the old one)', async () => {
    const packet = await captureAdvocacy('CROWN_REVISED_THEORY_941')
    expect(packet).toContain('Private theory for this advocate only: CROWN_REVISED_THEORY_941')
    expect(packet).not.toContain('CROWN_PRIVATE_713')
  })

  it('is unchanged for a party with a single brief (valid control)', async () => {
    const packet = await captureAdvocacy()
    expect(packet).toContain('Private theory for this advocate only: CROWN_PRIVATE_713')
  })
})
