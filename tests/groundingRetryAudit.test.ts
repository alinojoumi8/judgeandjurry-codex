import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { GroundingAudit } from '../src/components/GroundingAudit'
import type { TrialRunView } from '../src/trialEngineTypes'

describe('checker retry audit wording', () => {
  it.each(['passed', 'failed'] as const)('reports the actual final check status: %s', status => {
    const trial = { events: [{ id: 'event-1', sequence: 1, actorId: 'crown', phase: 'openings', type: 'public_submission', modelAudit: {
      grounding: { status, repairs: 0, findings: [], errors: status === 'failed' ? ['Invalid JSON.'] : [], verificationRetries: 1 },
    } }] } as unknown as TrialRunView
    const html = renderToStaticMarkup(createElement(GroundingAudit, { trial, matterId: 'fictional' }))
    expect(html).toContain('The checker made 1 additional attempt(s).')
    expect(html).toContain(status === 'passed' ? 'The final check passed.' : 'The output remains withheld; see the errors below.')
    expect(html).not.toContain('to produce valid quotations and JSON')
  })
})
