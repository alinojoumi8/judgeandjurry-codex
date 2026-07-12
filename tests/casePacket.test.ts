import { describe, expect, it } from 'vitest'

import { buildCasePacket } from '../server/casePacket'
import type { EvidenceItem, Matter } from '../server/types'

describe('case packet builder', () => {
  it('includes jurisdiction, narrative, exhibit ids, and citation rules', () => {
    const matter: Matter = {
      id: 'm1',
      title: 'Smith v. Northbridge',
      jurisdiction: 'Ontario, Canada',
      narrative: 'Slip and fall claim.',
      createdAt: '2026-06-23T00:00:00.000Z',
      updatedAt: '2026-06-23T00:00:00.000Z',
    }
    const evidence: EvidenceItem[] = [
      {
        id: 'ev1',
        matterId: matter.id,
        exhibitId: 'E-001',
        name: 'Incident report.pdf',
        type: 'pdf',
        mimeType: 'application/pdf',
        size: 123,
        text: 'The report says the lot was wet.',
        summary: 'Wet lot report.',
        tags: ['Timeline'],
        uploadedAt: '2026-06-23T00:00:00.000Z',
        sha256: null,
        sourceAvailable: false,
        ingestionStatus: 'metadata_only',
        extractionWarning: null,
        archivedAt: null,
      },
    ]

    const packet = buildCasePacket(matter, evidence)

    expect(packet).toContain('Ontario, Canada')
    expect(packet).toContain('Slip and fall claim.')
    expect(packet).toContain('E-001 - Incident report.pdf')
    expect(packet).toContain('Cite exhibit IDs')
  })
})
