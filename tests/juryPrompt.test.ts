import { describe, expect, it } from 'vitest'
import { MiniMaxClient, type StageRequest } from '../server/minimax'
import { defaultJurorProfiles } from '../server/jurors'
import { courtroomAuditEvents } from '../server/grounding'
import { supportedOpeningRequest } from '../samples/courtroom-realism/supported-opening'
import type { TrialEvent } from '../server/trialEngineTypes'

const config = { provider: 'openai-compatible' as const, model: 'offline', baseUrl: 'http://127.0.0.1:11434/v1', apiKey: 'fixture', timeoutMs: 1000, maxRetries: 0 }
async function capture(request: StageRequest, audit = false) {
  let prompt = ''
  const client = new MiniMaxClient(config, undefined, async (_url, init) => { prompt = JSON.parse(String(init?.body)).messages.map((m: {content:string}) => m.content).join('\n'); throw new Error('capture') })
  await expect(audit ? client.reviewGrounding(request, { title: '', content: 'A visible juror urged restraint.', citations: [], jurors: [] }) : client.generateStage(request)).rejects.toThrow('capture')
  return prompt
}
describe('live jury source and state contracts', () => {
  it('keeps a delivered jury-return obligation separate from the standing instruction', async () => {
    const request = { ...supportedOpeningRequest, stage: 'defence_rebuttal', courtroomState: { juryPresent: true, examination: 'complete' as const } }
    const prompt = await capture(request)
    expect(prompt).toContain('"juryPresent":true')
    expect(prompt).toContain('Do not ask for jury return or repeat a pre-return delivery reminder in closings')
    expect(prompt).toContain('Do not shorten "no knowing-participation element is supplied" into "no participation is supplied"')
    const audit = await capture(request, true)
    expect(audit).toContain('Approved current courtroom state: {"juryPresent":true,"examination":"complete"}')
  })
  it.each(['juror_ballot', 'jury_deliberation'])('gives an isolated %s its own schema without invented panel history', async stage => {
    const profile = { ...defaultJurorProfiles('test', 12, 'criminal_defence')[0], id: 'p1' }
    const prompt = await capture({ ...supportedOpeningRequest, stage, jurorProfiles: [profile], ballotRound: 'final', packet: `${supportedOpeningRequest.packet}\nAcknowledge instructionEventId: current-charge-id.` })
    expect(prompt).not.toContain('simulate the jury-room exchange between them')
    expect(prompt).not.toContain('beliefTrail with four snapshots')
    expect(prompt).not.toContain('deliberationRounds with 2 or 3 rounds')
    const shape = JSON.parse(prompt.split('Return this JSON shape:\n')[1])
    expect(shape.verdict).toBeNull()
    expect(shape.jurors).toHaveLength(1)
    expect(shape.jurors[0]).toMatchObject({ juror: profile.juror, instructionEventId: 'current-charge-id', beliefTrail: [], deliberationRounds: [] })
  })
  it.each(['juror_ballot', 'defence_rebuttal'])('keeps %s author guidance consistent with permitted proof', async stage => {
    const prompt = await capture({ ...supportedOpeningRequest, stage })
    expect(prompt).not.toContain('Exclusively attributed material cannot prove')
    expect(prompt).toContain('A permitted attributed account may prove the supplied condition if credited under the supplied burden')
    expect(prompt).toContain('Never introduce a categorical source-class incapacity or a mandatory corroboration requirement absent a supplied instruction')
    expect(prompt).toContain('An account narrating departure does not supply eyewitness observation of that departure')
  })
  it.each([[8,'low'],[80,'high']])('renders skepticism %s on the explicit 100-point scale',async(value,label)=>{
    const profile={...defaultJurorProfiles('test',12,'criminal_defence')[0],id:'p1',skepticismLevel:Number(value)}
    const prompt=await capture({...supportedOpeningRequest,stage:'juror_ballot',jurorProfiles:[profile]})
    expect(prompt).toContain(`Skepticism: ${value}/100 (${label})`)
  })
  it('audits authorized deliberation attribution without copying arbitrary private fields', () => {
    const events = [{ id: 'j1', type: 'juror_deliberation_turn', actorId: 'juror-02', phase: 'deliberation_inventory', payload: { contribution: 'The account is uncertain.', round: 1, secretProfile: 'PRIVATE_999' } }] as unknown as TrialEvent[]
    expect(courtroomAuditEvents(events)).toEqual([{ eventId: 'j1', type: 'juror_deliberation_turn', actorId: 'juror-02', phase: 'deliberation_inventory', payload: { contribution: 'The account is uncertain.', round: 1 } }])
  })
})
