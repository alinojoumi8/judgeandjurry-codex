import { describe, expect, it } from 'vitest'

import {
  citationRefsFromIds,
  citationWarningsForText,
  extractCitationIds,
  validateCitationIds,
} from '../server/citations'
import type { EvidenceItem } from '../server/types'

const evidence: EvidenceItem[] = [
  {
    id: 'ev1',
    matterId: 'm1',
    exhibitId: 'E-001',
    name: 'Incident report.pdf',
    type: 'pdf',
    mimeType: 'application/pdf',
    size: 10,
    text: 'Incident report',
    summary: 'Incident report',
    tags: ['Timeline'],
    uploadedAt: '2026-06-23T00:00:00.000Z',
  },
]

describe('citation helpers', () => {
  it('extracts unique exhibit ids from prose', () => {
    expect(extractCitationIds('See E-001 and E-002. E-001 repeats.')).toEqual([
      'E-001',
      'E-002',
    ])
  })

  it('splits supported and unsupported citations', () => {
    expect(validateCitationIds(['E-001', 'E-099'], evidence)).toEqual({
      supported: ['E-001'],
      unsupported: ['E-099'],
    })
  })

  it('builds citation refs only for known evidence', () => {
    expect(citationRefsFromIds(['E-001', 'E-099'], evidence)).toEqual([
      { exhibitId: 'E-001', evidenceId: 'ev1', label: 'Incident report.pdf' },
    ])
  })

  it('warns when an evidence-grounded output has no citations', () => {
    expect(citationWarningsForText('The hazard was visible.', [], evidence)).toEqual([
      'Agent output contained no exhibit citations.',
    ])
  })
})
