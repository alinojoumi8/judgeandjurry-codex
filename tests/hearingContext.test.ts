import { describe, expect, it } from 'vitest'
import { MiniMaxClient } from '../server/minimax'
import { supportedOpeningRequest } from '../samples/courtroom-realism/supported-opening'
import { courtroomAuditEvents } from '../server/grounding'
import type { TrialEvent } from '../server/trialEngineTypes'

const config = { provider: 'openai-compatible' as const, model: 'offline', apiKey: 'fixture', baseUrl: 'http://127.0.0.1:11434/v1', timeoutMs: 1000, maxRetries: 0 }
describe('courtroom source boundaries after Crown opening', () => {
  it('preserves submission attribution while excluding strategies, private fields and owner audits', () => {
    const events = [
      { id: 'q1', type: 'witness_question', payload: { witnessId: 'w1', text: 'What did you observe?', privateTheory: 'PRIVATE_EVENT_999', courtroomState: { secret: 'PRIVATE_STATE_777' } }, modelAudit: { secret: 'PRIVATE_AUDIT_888' } },
      { id: 'p1', type: 'private_strategy_selected', payload: { text: 'PRIVATE_STRATEGY_555' } },
      { id: 's1', type: 'public_submission', actorId: 'crown', phase: 'openings', payload: { text: 'INVENTED_ADVOCACY_666', privateTheory: 'PRIVATE_SUBMISSION_777' } },
      { id: 'r1', type: 'objection_ruling', payload: { outcome: 'sustained', reasons: 'Fictional scope instruction.', authorityIds: ['fixture'] } },
    ] as unknown as TrialEvent[]
    expect(courtroomAuditEvents(events)).toEqual([{ eventId: 'q1', type: 'witness_question', payload: { witnessId: 'w1', text: 'What did you observe?' } }, { eventId: 's1', type: 'public_submission', actorId: 'crown', phase: 'openings', payload: { text: 'INVENTED_ADVOCACY_666' } }, { eventId: 'r1', type: 'objection_ruling', payload: { outcome: 'sustained', reasons: 'Fictional scope instruction.', authorityIds: ['fixture'] } }])
  })
  it.each(['defence_opening', 'witness_question', 'witness_answer', 'judge_ruling', 'crown_rebuttal', 'defence_rebuttal'])('audits %s against approved setup rather than private advocacy or prior prose', async stage => {
    let prompt = ''
    const client = new MiniMaxClient(config, undefined, async (_url, init) => { prompt = JSON.parse(String(init?.body)).messages.map((m: { content: string }) => m.content).join('\n'); throw new Error('capture') })
    const request = { ...supportedOpeningRequest, stage, approvedPartyRoles: [{ id: 'ellis', name: 'Fictional Ellis', role: 'accused' as const }], packet: 'Approved scenario procedure: Fictional contents-premise questions must be sustained.\nPinned legal packet abc123: {"condition":"fictional handover"}\nPrivate theory: PRIVATE_HEARING_444', previousTurns: 'PRIOR_ASSERTION_555' }
    await expect(client.reviewGrounding(request, { title: '', content: 'Ellis is the accused in this exercise.', citations: [], jurors: [] })).rejects.toThrow('capture')
    expect(prompt).toContain('Approved party roles: [{"id":"ellis","name":"Fictional Ellis","role":"accused"}]')
    expect(prompt).toContain('fictional handover')
    expect(prompt).toContain('Role assignments remain factual premises inside negations')
    expect(prompt).toContain('Source availability does not establish procedural status')
    expect(prompt).toContain('Repeating a visible question does not authorize its unsupported presuppositions')
    expect(prompt).toContain('The proposed-question rule does not reject a ruling or objection')
    expect(prompt).toContain('Setup-supported instruction statements are analysis')
    expect(prompt).toContain('A legal characterization cannot reverse an opponent\'s explicit denial')
    expect(prompt).toContain('A negative inference boundary is not an assertion of universal knowledge')
    expect(prompt).toContain('The approved author may adopt a present argument')
    expect(prompt).toContain('A decision to stop is not a ruling that no further inquiry is permitted')
    expect(prompt).not.toMatch(/PRIVATE_HEARING_444|PRIOR_ASSERTION_555/)
  })

  it.each(['defence_opening', 'witness_question', 'witness_answer', 'judge_ruling', 'crown_rebuttal', 'defence_rebuttal'])('keeps %s author packet metadata separate from evidence', async stage => {
    let prompt = ''
    const client = new MiniMaxClient(config, undefined, async (_url, init) => { prompt = JSON.parse(String(init?.body)).messages.map((m: { content: string }) => m.content).join('\n'); throw new Error('capture') })
    await expect(client.generateStage({ ...supportedOpeningRequest, stage })).rejects.toThrow('capture')
    expect(prompt).toContain('Courtroom claim contract')
    expect(prompt).not.toContain('The uploaded case packet is relevant evidence.')
    expect(prompt).toContain('A question is not testimony')
    expect(prompt).toContain('Do not say "the only source before you"')
    expect(prompt).toContain('Agreement is a valid response')
  })
  it('gives the courtroom witness a record-bound deferral rather than an invented memory limit', async () => {
    let prompt = ''
    const client = new MiniMaxClient(config, undefined, async (_url, init) => { prompt = JSON.parse(String(init?.body)).messages[1].content; throw new Error('capture') })
    await expect(client.generateStage({ ...supportedOpeningRequest, stage: 'witness_answer' })).rejects.toThrow('capture')
    expect(prompt).toContain('My approved account does not address that point')
    expect(prompt).not.toContain('say plainly that you do not recall or do not know')
  })
  it('includes an explicit boolean in the completion response schema', async () => {
    let prompt = ''
    const client = new MiniMaxClient(config, undefined, async (_url, init) => { prompt = JSON.parse(String(init?.body)).messages[1].content; throw new Error('capture') })
    await expect(client.generateStage({ ...supportedOpeningRequest, stage: 'examination_completion' })).rejects.toThrow('capture')
    expect(typeof JSON.parse(prompt.split('Return this JSON shape:\n')[1]).examinationComplete).toBe('boolean')
    expect(prompt).toContain('Give only your present decision; omit reasons about testimony or legal prohibitions')
  })
  it('keeps a scope ruling focused on the objection rather than a jury verdict', async () => {
    let prompt = ''
    const client = new MiniMaxClient(config, undefined, async (_url, init) => { prompt = JSON.parse(String(init?.body)).messages[1].content; throw new Error('capture') })
    await expect(client.generateStage({ ...supportedOpeningRequest, stage: 'judge_ruling', verdictOutcomes: ['sustained', 'overruled', 'reserved'] })).rejects.toThrow('capture')
    expect(prompt).not.toContain('explicitly account for the jury split')
    expect(prompt).toContain('pending objection')
    expect(JSON.parse(prompt.split('Return this JSON shape:\n')[1]).jurors).toEqual([])
  })
  it('uses high MiniMax reasoning for the independent courtroom source audit', async () => {
    let body: { reasoning_effort?: string } = {}
    const client = new MiniMaxClient({ ...config, provider: 'minimax' }, undefined, async (_url, init) => { body = JSON.parse(String(init?.body)); throw new Error('capture') })
    await expect(client.reviewGrounding({ ...supportedOpeningRequest, stage: 'crown_rebuttal' }, { title: '', content: 'The supplied account records unknown contents.', citations: [], jurors: [] })).rejects.toThrow('capture')
    expect(body.reasoning_effort).toBe('high')
  })
  it('does not require a Crown closing to construct competing inferences or corroboration', async () => {
    let prompt = ''
    const client = new MiniMaxClient(config, undefined, async (_url, init) => { prompt = JSON.parse(String(init?.body)).messages[1].content; throw new Error('capture') })
    await expect(client.generateStage({ ...supportedOpeningRequest, stage: 'crown_rebuttal' })).rejects.toThrow('capture')
    expect(prompt).not.toContain('with the best available corroboration')
    expect(prompt).toContain('Accept genuine agreement on source limits')
  })
})
