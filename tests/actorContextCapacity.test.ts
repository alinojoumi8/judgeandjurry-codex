import { describe, expect, it } from 'vitest'
import { actorContextCharacters, assembleActorContext } from '../server/actorContext'
import { formatSourceRecord } from '../server/grounding'
import type { MemoryInput } from '../server/actorMemory'
import type { EvidenceItem } from '../server/types'

const source = (text: string): EvidenceItem => ({ id: 'source', exhibitId: 'E-001', name: 'record', text,
  summary: '', authorizedPassages: [{ paragraph: 82, text, startOffset: 900, endOffset: 900 + text.length }] } as EvidenceItem)
const input = (evidence: EvidenceItem[]): MemoryInput => ({ runId: 'r', actorId: 'juror-01', roles: ['juror'], protocol: false,
  throughSequence: 1, events: [], evidence, uses: [{ id: 'use-1', ledgerVersionId: 'ledger-1', evidenceId: 'source', status: 'limited', purposes: [], redactions: [], hiddenFrom: [], note: '', scope: { paragraphs: [82] } }], approvedStatementRefs: [] })

describe('canonical actor context capacity', () => {
  it('budgets the exact source rendering once, preserving original paragraph labels and complete text', () => {
    const evidence = [source('Permitted account. '.repeat(4000))]
    expect(JSON.stringify(evidence).length).toBeGreaterThan(100000)
    expect(actorContextCharacters(evidence)).toBe(formatSourceRecord(evidence).length)
    const result = assembleActorContext(input(evidence), 100000)
    expect(formatSourceRecord(result.evidence)).toContain('[E-001 paragraph 82]')
    expect(result.evidence[0].text).toBe(evidence[0].text)
    expect(result.manifest.sourceRefs).toHaveLength(1)
    expect(result.manifest.omittedEventIds).toEqual([])
  })

  it('fails closed when the canonical source or complete visible history exceeds the unchanged cap', () => {
    const evidence = [source('x'.repeat(241000))]
    expect(() => assembleActorContext(input(evidence))).toThrow(/240000 character budget/)
    const small = input([source('A permitted account.')])
    small.events.push({ id: 'e', trialRunId: 'r', sequence: 1, phase: 'evidence', type: 'witness_answer',
      visibleTo: ['public'], sourceRefs: [], payload: { text: 'EARLY_ACCOUNT ' + 'x'.repeat(241000) }, createdAt: '2026-10-23' })
    expect(() => assembleActorContext(small)).toThrow(/no material was silently omitted/)
  })
})
