import { reviewWithIndependentScopeCheck } from './independentScopeCheck'
import { describe, expect, it } from 'vitest'
import { MiniMaxClient } from '../server/minimax'

const present = { juryPresent: true, examination: 'complete' }
const check = (text: string, state = present) => reviewWithIndependentScopeCheck('analysis',
  JSON.stringify({ findings: [{ unitId: 'content:1', status: 'analysis', citations: [] }] }),
  [{ id: 'content:1', text }], [], '', undefined,
  { packet: 'Account only; no contents or guilt proof.', events: [], actorRoles: ['defence'], partyRoles: [], courtroomState: state },
).status

describe('current jury instruction state', () => {
  it('keeps a current no-pending observation distinct from delivery proof', () => {
    const audit = (text: string, state: { juryPresent: boolean; examination: string; pendingInstruction?: string } | null = present) => reviewWithIndependentScopeCheck('analysis',
      JSON.stringify({ findings: [{ unitId: 'content:1', status: 'unsupported', citations: [] }] }),[{ id: 'content:1', text }],[], '', undefined,
      { packet: 'Fictional instruction.', events: [], actorRoles: ['defence'], partyRoles: [], courtroomState: state ?? undefined },
    ).status
    expect(audit('The limiting instruction is not still pending.')).toBe('passed')
    expect(audit('The limiting instruction is not still pending.',{juryPresent:false,examination:'cross',pendingInstruction:'Account only.'})).toBe('failed')
    expect(audit('The limiting instruction was delivered.')).toBe('failed')
    expect(audit('The limiting instruction is not still pending. It was delivered earlier.')).toBe('failed')
    expect(audit('The limiting instruction is not still pending.', null)).toBe('failed')
    expect(audit('The limiting instruction is not still pending.',{juryPresent:false,examination:'cross'})).toBe('failed')
  })
  it('passes the actual current state through the model checker integration', async () => {
    const client = new MiniMaxClient({ provider: 'minimax', apiKey: 'fictional-key', baseUrl: 'https://fixture.invalid/v1', model: 'fixture', timeoutMs: 10000, maxRetries: 0 }, undefined,
      async () => Response.json({ choices: [{ message: { content: JSON.stringify({ findings: [{ unitId: 'content:1', status: 'analysis', citations: [] }] }) } }] }))
    const review = await client.reviewGrounding({ stage: 'defence_rebuttal', courtroomProtocol: true, packet: 'Fictional source-use restriction.', evidence: [], previousTurns: '', courtroomEvents: [], courtroomActor: { id: 'accused-1', name: 'Fictional Defence', roles: ['defence'] }, courtroomState: present },
      { title: '', content: 'Before jury return, the limiting instruction remains required; the jury must remain out.', citations: [], jurors: [] })
    expect(review.status).toBe('failed')
  })
  it('rejects an outstanding pre-return obligation when the jury is present with none pending', () => {
    expect(check('Before jury return, the limiting instruction remains required; the jury must remain out.')).toBe('failed')
    expect(check('The limiting instruction is still pending.')).toBe('failed')
    expect(check('The jury may not return until the instruction is delivered.')).toBe('failed')
  })
  it('preserves source-use reminders, neutral questions and conditional rules', () => {
    for (const text of [
      'The limited-use instruction remains applicable to assessment.',
      'Is the limiting instruction still pending?',
      'If an instruction is pending, the jury must remain out.',
      'The limiting instruction is not still pending.',
      'We ask for a further reminder of the source-use restriction.',
    ]) expect(check(text)).toBe('passed')
  })
  it('preserves an actual pending instruction with the jury out', () => {
    const state = { juryPresent: false, examination: 'cross', pendingInstruction: 'Account only.' }
    expect(check('Before jury return, the limiting instruction remains required; the jury must remain out.', state)).toBe('passed')
  })
})
