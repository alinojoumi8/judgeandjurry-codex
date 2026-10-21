import { describe, expect, it } from 'vitest'
import { MiniMaxClient, type StageRequest } from '../server/minimax'
import { createCourtroomFixture } from '../samples/courtroom-realism/fixture'
import { supportedOpeningRequest } from '../samples/courtroom-realism/supported-opening'

const config = { provider: 'openai-compatible' as const, model: 'offline', apiKey: 'fixture', baseUrl: 'http://127.0.0.1:11434/v1', timeoutMs: 1000, maxRetries: 0 }
const roles = [{ id: 'ellis', name: 'Fictional Ellis', role: 'accused' as const }]
const disclaimer = "The Crown opens on a handover between Rowan and Ellis, not guilt on the part of either accused."

describe('opening approved identity and role boundaries', () => {
  it('carries approved case party identities without inferring roles from source names', async () => {
    let request: StageRequest | undefined
    const f = createCourtroomFixture({ async generateStage(r) { request = r; throw new Error('capture') } })
    try { await f.engine.runAutonomous(f.run.id) } catch { /* capture */ }
    const expected = f.model.parties.map(({ id, name, role }) => ({ id, name, role }))
    f.store.close()
    expect(request).toBeDefined()
    expect(request!.approvedPartyRoles).toEqual(expected)
    expect(JSON.stringify(request!.approvedPartyRoles)).not.toContain('CROWN_PRIVATE_713')
    expect(request!.approvedPartyRoles?.some(p => p.name === 'Fictional Rowan')).toBe(false)
  })

  it.each([false, true])('shows explicit role mappings to the %s checker/author without private metadata', async checker => {
    let prompt = ''
    const client = new MiniMaxClient(config, undefined, async (_url, init) => {
      prompt = JSON.parse(String(init?.body)).messages.map((m: { content: string }) => m.content).join('\n')
      throw new Error('capture')
    })
    const request = { ...supportedOpeningRequest, approvedPartyRoles: roles.map(r => ({ ...r, representedBy: 'PRIVATE_ROLE_777' })) }
    const work = checker ? client.reviewGrounding(request, { title: '', content: disclaimer, citations: [], jurors: [] }) : client.generateStage(request)
    await expect(work).rejects.toThrow('capture')
    expect(prompt).toContain('Approved party roles: [{"id":"ellis","name":"Fictional Ellis","role":"accused"}]')
    expect(prompt).not.toContain('PRIVATE_ROLE_777')
    expect(prompt).toContain('Role assignments remain factual premises inside negations, disclaimers and mixed sentences')
  })

  it('makes absent role mappings explicit rather than using a source name or private theory as an accused identity', async () => {
    let prompt = ''
    const client = new MiniMaxClient(config, undefined, async (_url, init) => {
      prompt = JSON.parse(String(init?.body)).messages.map((m: { content: string }) => m.content).join('\n')
      throw new Error('capture')
    })
    await expect(client.reviewGrounding({ ...supportedOpeningRequest, packet: supportedOpeningRequest.packet + '\nPrivate theory: Ellis is accused.' }, { title: '', content: disclaimer, citations: [], jurors: [] })).rejects.toThrow('capture')
    expect(prompt).toContain('Approved party roles: []')
    expect(prompt).toContain('either accused')
    expect(prompt).not.toContain('Private theory: Ellis is accused.')
  })

  it.each([false, true])('requires actual source status support in the %s checker/author', async checker => {
    let prompt = ''
    const client = new MiniMaxClient(config, undefined, async (_url, init) => {
      prompt = JSON.parse(String(init?.body)).messages.map((m: { content: string }) => m.content).join('\n')
      throw new Error('capture')
    })
    const draft = { title: '', content: 'E-101 is a disclosed observational account; other accounts may exist in overall disclosure.', citations: [], jurors: [] }
    await expect(checker ? client.reviewGrounding(supportedOpeningRequest, draft) : client.generateStage(supportedOpeningRequest)).rejects.toThrow('capture')
    expect(prompt).toContain('Source availability does not establish procedural status')
    expect(prompt).toContain('A disclaimer that other disclosure may exist does not supply disclosure status for this item')
  })
})
