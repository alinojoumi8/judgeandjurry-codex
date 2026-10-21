import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { GroundingAudit } from '../src/components/GroundingAudit'
import type { TrialRunView } from '../src/trialEngineTypes'

function render(type = 'juror_deliberation_turn', includeRecord = true) {
  const trial = { events: [
    { id: 'original-record-id', sequence: 3, type, actorId: 'juror-04', phase: 'instructions', payload: { text: 'Do not substitute this current payload for the saved audit quotation.' } },
    { id: 'audit-event', sequence: 5, type: 'juror_deliberation_turn', actorId: 'juror-01', phase: 'deliberation_review', payload: {}, modelAudit: { grounding: { status: 'passed', repairs: 0, errors: [], findings: [{ unitId: 'content:1', status: 'analysis', text: 'I assess the supplied discussion.', explanation: 'Accurate attribution.', citations: [], ...(includeRecord ? { recordCitations: [{ eventId: 'original-record-id', actorId: 'juror-04', quote: 'Preserved quoted words <from the record>.' }] } : {}) }] } } },
  ] } as unknown as TrialRunView
  return renderToStaticMarkup(createElement(GroundingAudit, { trial, matterId: 'fictional-matter' }))
}

describe('saved record citations in the grounding audit', () => {
  it('shows the saved peer reference and safely escaped original quotation', () => {
    const html = render()
    expect(html).toContain('Recorded contribution #3')
    expect(html).toContain('original-record-id')
    expect(html).toContain('Preserved quoted words &lt;from the record&gt;.')
    expect(html).not.toContain('Do not substitute')
  })
  it('labels instruction references as instructions', () => {
    expect(render('judicial_instruction')).toContain('Instruction #3')
  })
  it('keeps legacy audits with no record citations readable', () => {
    const html = render('juror_deliberation_turn', false)
    expect(html).toContain('Accurate attribution.')
    expect(html).not.toContain('original-record-id')
  })
})
