import { expect, it } from 'vitest'
import { MiniMaxClient } from '../server/minimax'
import { defaultJurorProfiles } from '../server/jurors'

it('canonicalizes a validated display alias without allowing another juror to answer', async () => {
  const profile = { ...defaultJurorProfiles('identity', 12, 'criminal_defence')[0], id: 'profile-1' }
  const alias = profile.juror.toUpperCase().replace(/\s/g, '').replace(/\d+$/, n => n.padStart(2, '0'))
  const client = (name: string) => new MiniMaxClient({ provider: 'minimax', apiKey: 'offline', baseUrl: 'https://fixture.invalid', model: 'fixture', timeoutMs: 2000, maxRetries: 0 }, undefined, async () => Response.json({ choices: [{ message: { content: JSON.stringify({ title: 'Ballot', content: 'Independent assessment.', citations: [], jurors: [{ juror: name, leaning: 'defence', confidence: 60, rationale: 'Independent assessment.', citations: [] }] }) } }] }))
  const request = { courtroomProtocol: true, stage: 'juror_ballot', packet: '', evidence: [], previousTurns: '', jurorProfiles: [profile] }
  expect((await client(alias).generateStage(request)).jurors?.[0]?.juror).toBe(profile.juror)
  await expect(client('Juror 999').generateStage(request)).rejects.toThrow('requested isolated juror')
})
