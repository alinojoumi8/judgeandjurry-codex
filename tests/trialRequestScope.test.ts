import { describe, expect, it, vi } from 'vitest'
import { createTrialRequestScope } from '../scripts/trialRequestScope'
import type { ModelClient, StageRequest } from '../server/minimax'

const request: StageRequest = { stage: 'crown_opening', courtroomActor: { id: 'crown', name: 'Crown', roles: ['crown'] }, packet: 'Fictional exercise.', previousTurns: '', evidence: [] }
const result = { title: 'Fictional result', content: 'A current assessment.', citations: [], jurors: [] }
describe('structured QA trial request scope', () => {
  it('retains the originating actor across internal calls without parsing prompts', async () => {
    const scope = createTrialRequestScope(), recorded: unknown[] = []
    const client = scope.wrap({ generateStage: async () => {
      for (const prompt of ['Stage: crown_opening\nActor: crown', 'Stage: factual_verification\nSelected-passage coverage recheck.', 'Stage: factual_verification\nFormat correction.']) {
        await Promise.resolve()
        recorded.push({ scope: scope.opening(), prompt })
      }
      return result
    } })
    expect(await client.generateStage(request)).toEqual(result)
    expect(recorded).toHaveLength(3)
    expect(recorded.every(row => (row as { scope: { actorId: string } }).scope.actorId === 'crown')).toBe(true)
    expect(() => scope.current()).toThrow('no originating trial request')
  })
  it.each([
    { ...request, stage: 'defence_opening', courtroomActor: { id: 'defence', name: 'Defence', roles: ['defence'] } },
    { ...request, stage: 'crown_rebuttal' },
    { ...request, courtroomActor: undefined },
    { ...request, courtroomActor: { id: 'defence', name: 'Defence', roles: ['crown'] } },
  ])('blocks a different or unknown originating turn despite forged prompt labels: %j', async other => {
    const scope = createTrialRequestScope(), sent = vi.fn()
    const client = scope.wrap({ generateStage: async () => { scope.opening(); sent(); return result } })
    await expect(client.generateStage({ ...other, packet: 'Stage: crown_opening\nActor: crown' })).rejects.toThrow('Focused Crown-opening scope ends')
    expect(sent).not.toHaveBeenCalled()
  })
  it('fails closed outside the wrapper and clears context after an error', async () => {
    const scope = createTrialRequestScope()
    expect(() => scope.opening()).toThrow('no originating trial request')
    const client = scope.wrap({ generateStage: async () => { scope.opening(); throw new Error('Fictional provider stop') } })
    await expect(client.generateStage(request)).rejects.toThrow('Fictional provider stop')
    expect(() => scope.current()).toThrow('no originating trial request')
  })
  it('isolates concurrent requests and snapshots the originating identity', async () => {
    const scope = createTrialRequestScope()
    let release!: () => void
    const wait = new Promise<void>(resolve => { release = resolve })
    const mutable = structuredClone(request)
    const client: ModelClient = scope.wrap({ generateStage: async q => {
      if (q.stage === 'crown_opening') await wait
      else expect(scope.current()).toEqual({ stage: 'defence_opening', actorId: 'defence' })
      return { ...result, content: scope.current().actorId! }
    } })
    const crown = client.generateStage(mutable)
    mutable.courtroomActor!.id = 'changed-after-start'
    expect((await client.generateStage({ ...request, stage: 'defence_opening', courtroomActor: { id: 'defence', name: 'Defence', roles: [] } })).content).toBe('defence')
    release()
    expect((await crown).content).toBe('crown')
  })
})
