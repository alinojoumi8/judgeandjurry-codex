import { afterEach, describe, expect, it } from 'vitest'
import { CaseWorkflowService } from '../server/caseWorkflow'
import { CaseStore } from '../server/db'
import type { GroundingUnit } from '../server/grounding'
import { MiniMaxClient, type ModelClient, type StageRequest } from '../server/minimax'
import { TrialEngineService } from '../server/trialEngine'

const stores: CaseStore[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close() })
const contract = 'Public-submission attribution contract (also applies to every repair)'
const good = 'Rowan states the funds paid for development of the experiment (E-001).'
const bad = 'The Defence points to Mira’s failed-experiment explanation (E-001).'
const corrected = 'Rowan’s affidavit attributes the experiment-development explanation to Rowan (E-001).'

function fixture(target?: ModelClient) {
  const store = new CaseStore(':memory:'); stores.push(store)
  const matter = store.createMatter({ title: 'Fictional attribution exercise', narrative: 'A disputed experiment-development account.' })
  const text = 'Fictional affidavit by Rowan. Rowan states: The funds paid for development of the experiment. Rowan disputes Mira’s account.'
  store.addEvidence(matter.id, { name: 'rowan-affidavit.txt', type: 'text', mimeType: 'text/plain', size: Buffer.byteLength(text), text, summary: text, tags: [], ingestionStatus: 'stored' })
  const workflow = new CaseWorkflowService(store)
  const model = workflow.approveCaseModel(workflow.draftCaseModel(matter.id, 'ontario_criminal_jury_v1', { witnesses: [] }).id)
  workflow.saveTheoryBrief({ caseModelId: model.id, partyId: 'crown', side: 'crown', narrative: 'PRIVATE_CROWN: an unverified theory is not a party submission.' })
  workflow.saveTheoryBrief({ caseModelId: model.id, partyId: 'accused-1', side: 'defence', narrative: 'PRIVATE_DEFENCE: not available to the Crown.' })
  const requests: StageRequest[] = []
  const engine = new TrialEngineService(store, { generateStage: async request => {
    requests.push(request)
    if (request.stage === 'crown_rebuttal' && target) return target.generateStage(request)
    const juror = request.jurorProfiles?.[0]?.juror
    return { title: 'Fictional position', content: good, citations: ['E-001'], jurors: juror ? [{ juror, leaning: 'crown' as const, confidence: 70, rationale: good, citations: ['E-001'] }] : [],
      verdict: request.stage === 'judge_ruling' ? { outcome: 'crown', confidence: 70, keyFactors: ['E-001'], unresolvedIssues: [], recommendedNextSteps: [], citationWarnings: [] } : undefined }
  } })
  const run = engine.createRun({ matterId: matter.id, caseModelId: model.id, config: { mode: 'full', procedureAdapter: 'ontario_criminal_jury_v1', seed: 'attribution-fixture', checkpointPolicy: { default: 'autonomous', approvalPhases: [], allowCounselTakeover: true }, witnessPlan: [], deliberation: { maxRounds: 1, concurrency: 1 }, externalDisclosureConfirmed: false } }).run
  return { store, engine, run, requests }
}

function repairClient(persistent = false) {
  const authorPrompts: string[] = [], checkerPrompts: string[] = []
  let authors = 0
  const client = new MiniMaxClient({ provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:11434/v1', model: 'fictional', timeoutMs: 1000, maxRetries: 1 }, undefined, async (_url, init) => {
    const prompt = JSON.parse(String(init?.body)).messages[1].content as string
    let result: unknown
    if (prompt.includes('Draft units to check:\n')) {
      checkerPrompts.push(prompt)
      const units = JSON.parse(prompt.split('Draft units to check:\n')[1]) as GroundingUnit[]
      result = { findings: Object.fromEntries(units.map(unit => {
        const rejected = unit.text.includes('The Defence points to Mira')
        const source = unit.text.includes('E-001')
        return [unit.id, { status: rejected ? 'unsupported' : source ? 'supported' : 'analysis', supportTypes: source ? ['source'] : ['analysis'], explanation: rejected ? 'The source attributes the development account to Rowan; no visible Defence submission supports that different speaker or account.' : source ? 'The source attributes this account to Rowan.' : 'Descriptive heading.', citations: source ? [{ exhibitId: 'E-001', paragraph: 1 }] : [], recordCitations: [] }]
      })) }
    } else {
      authorPrompts.push(prompt)
      result = ++authors === 1 ? { title: 'Fictional reply', content: `${good} ${bad}`, citations: ['E-001'], jurors: [] } : { repairs: [{ unitId: 'content:2', replacement: persistent ? bad : corrected }] }
    }
    return Response.json({ choices: [{ message: { content: JSON.stringify(result) } }] })
  })
  return { client, authorPrompts, checkerPrompts }
}

describe('public advocate source and party attribution', () => {
  it('uses only the authorized submission projection and keeps source identity distinct from party arguments', async () => {
    const { store, engine, run, requests } = fixture()
    const hidden = store.workflow.appendTrialEvent({ trialRunId: run.id, phase: 'openings', type: 'public_submission', actorId: 'accused-1', visibleTo: ['accused-1', 'role:system'], payload: { text: 'HIDDEN_PARTY_POSITION' }, sourceRefs: [] })
    const visible = store.workflow.appendTrialEvent({ trialRunId: run.id, phase: 'openings', type: 'public_submission', actorId: 'accused-1', visibleTo: ['public'], payload: { text: 'The fictional Defence asks for proof of each element.' }, sourceRefs: [] })
    await engine.runAutonomous(run.id)
    const opening = requests.find(request => request.stage === 'crown_opening')!
    expect(opening.packet).toContain(contract)
    expect(opening.packet).toContain(`Actor-visible other-party submission references (positions, not evidence truth): [{"eventId":"${visible.id}","actorId":"accused-1"}]`)
    const closing = requests.find(request => request.stage === 'crown_rebuttal')!
    expect(closing.packet).toContain('Keep the document author, any quoted speaker, and the party making a public submission separate')
    expect(closing.packet).toContain('explicitly hypothetical challenge')
    expect(closing.packet).not.toContain('PRIVATE_DEFENCE')
    expect(closing.packet).not.toContain(hidden.id)
    expect(closing.packet).not.toContain('HIDDEN_PARTY_POSITION')
    const referenceJson = closing.packet.match(/Actor-visible other-party submission references \(positions, not evidence truth\): (\[[^\n]*\])/)! [1]
    const references = JSON.parse(referenceJson) as Array<{ eventId: string; actorId: string }>
    expect(references.length).toBeGreaterThan(0)
    for (const reference of references) {
      expect(reference.actorId).not.toBe('crown')
      expect(closing.courtroomEvents).toContainEqual(expect.objectContaining({ eventId: reference.eventId, actorId: reference.actorId, type: 'public_submission' }))
      expect(closing.courtroomEvents?.find(event => event.eventId === reference.eventId)?.payload.withheld).not.toBe(true)
    }
    expect(requests.filter(request => request.stage === 'juror_ballot').every(request => !request.packet.includes(contract))).toBe(true)
  })

  it('retains the source/party contract through a bounded repair while preserving the genuine rejection and accepted text', async () => {
    const harness = repairClient(), { store, engine, run } = fixture(harness.client)
    await engine.runAutonomous(run.id)
    expect(harness.authorPrompts).toHaveLength(2)
    for (const prompt of harness.authorPrompts) {
      expect(prompt).toContain(contract)
      expect(prompt).toContain('An exhibit, a private theory, a shared topic or a source-use permission cannot establish what another party submitted')
      expect(prompt).not.toContain('PRIVATE_DEFENCE')
    }
    expect(harness.checkerPrompts.every(prompt => !prompt.includes('PRIVATE_CROWN'))).toBe(true)
    const closing = store.workflow.listTrialEvents(run.id).find(event => event.type === 'public_submission' && event.actorId === 'crown' && event.phase === 'closings')!
    expect(closing.payload.text).toBe(`${good} ${corrected}`)
    expect(closing.modelAudit?.grounding?.status).toBe('passed')
    expect(closing.modelAudit?.grounding?.priorFailures?.[0].findings).toContainEqual(expect.objectContaining({ text: bad, status: 'unsupported' }))
    expect(closing.modelAudit?.grounding?.appliedRepairs).toContainEqual({ unitId: 'content:2', before: bad, replacement: corrected })
  })

  it('withholds a persistent source-speaker/party swap instead of promoting it through repair', async () => {
    const harness = repairClient(true), { store, engine, run } = fixture(harness.client)
    await expect(engine.runAutonomous(run.id)).rejects.toThrow('Source verification rejected')
    expect(harness.authorPrompts).toHaveLength(2)
    const events = store.workflow.listTrialEvents(run.id)
    expect(events.some(event => event.type === 'public_submission' && event.actorId === 'crown' && event.phase === 'closings')).toBe(false)
    expect(events.find(event => event.type === 'source_verification_failed')?.modelAudit?.grounding?.findings).toContainEqual(expect.objectContaining({ text: bad, status: 'unsupported' }))
  })
})
