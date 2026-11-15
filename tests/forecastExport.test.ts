import { describe, expect, it } from 'vitest'

import { buildForecastReport } from '../server/analysis/forecastExport'
import { forecastLabel, type ForecastArtifactView, type ForecastContent } from '../server/analysis/forecastTypes'
import { computeForecast } from '../server/forecast/study'
import { NOT_YET_TESTED_SENTENCE } from '../server/forecast/winRates'
import type { Matter } from '../server/types'

// A tiny study whose party, question and run names carry markup and fake headings.
const hostile = '<script>alert(1)</script>\n# Fake heading\n- fake bullet'
function content(): ForecastContent {
  const ballots = (votes: number) => Array.from({ length: 6 }, (_, index) => ({
    issueId: 'claim', actorId: `juror-0${index + 1}`, round: 'final' as const, choice: index < votes ? 'proved' : 'not_proved', valid: true,
  }))
  const runs = [6, 5, 4, 6].map((votes, index) => ({
    runId: `run-${index}`, seed: `seed-${index}`, status: 'completed', ballots: ballots(votes),
    decisions: [{ issueId: 'claim', outcome: votes >= 5 ? 'proved' : 'no_decision', complete: votes >= 5, rule: '5 of 6' }],
  }))
  return computeForecast({
    seed: hostile, mode: 'screen', ballotContract: 'v1', requestedRuns: 4, runs,
    issues: [{ id: 'claim', kind: 'civil_claim', label: hostile, permittedOutcomes: ['proved', 'not_proved', 'no_decision'], elementIds: [], elements: [], claimantPartyId: 'p', respondingPartyIds: ['d'], treatment: 'jury' }],
    parties: [{ id: 'p', name: hostile, role: 'plaintiff' }, { id: 'd', name: hostile, role: 'defendant' }],
    framework: { packId: hostile, packHash: 'a'.repeat(64), rulesAsOf: '2026-01-01', reviewStatus: 'unreviewed', panelSize: 6, threshold: 5, ruleText: hostile, reducedPanel: null },
  })
}
const matter = { id: 'm', title: hostile, narrative: '', jurisdiction: 'Ontario' } as unknown as Matter

function view(freshness: ForecastArtifactView['freshness'] = { status: 'current', reasons: [], notChecked: [] }): ForecastArtifactView {
  return {
    artifact: { id: 'a', matterId: 'm', kind: 'forecast', subjectKey: '', version: 1, status: 'draft', schemaVersion: 1, audience: 'owner', inputManifest: { evidenceHashes: [] }, contentHash: 'h', rejected: [], createdAt: '2026-01-01T00:00:00.000Z' },
    content: content(), freshness, label: forecastLabel,
  }
}

describe('forecast export', () => {
  it('escapes every dynamic string, and no supplied text can start a heading or a list item', () => {
    const report = buildForecastReport({ matter, view: view() })
    expect(report.html).not.toContain('<script>')
    expect(report.html).toContain('&lt;script&gt;')
    expect(report.markdown.split('\n').filter((line) => /^# /.test(line))).toHaveLength(1)
    expect(report.markdown).not.toMatch(/^# Fake heading/m)
    expect(report.markdown).not.toMatch(/^- fake bullet/m)
    expect(report.filename).not.toMatch(/[<>:"?*/]/)
  })

  it('opens and closes with the label whatever the state of the forecast, including out of date', () => {
    const out = view({ status: 'out_of_date', reasons: ['The case model has changed.'], notChecked: [] })
    for (const input of [view(), out]) {
      const { markdown, html } = buildForecastReport({ matter, view: input })
      expect(markdown.indexOf(NOT_YET_TESTED_SENTENCE)).toBeGreaterThan(-1)
      expect(markdown.lastIndexOf(NOT_YET_TESTED_SENTENCE)).toBeGreaterThan(markdown.indexOf('## Assumptions and limits'))
      expect(markdown.split(NOT_YET_TESTED_SENTENCE).length - 1).toBeGreaterThanOrEqual(3)
      expect(html).toContain(NOT_YET_TESTED_SENTENCE)
      expect(markdown).toMatch(/no calibrated estimate in this build/)
    }
    expect(buildForecastReport({ matter, view: out }).markdown).toContain('Out of date: The case model has changed.')
  })

  it('states a stored label cannot replace the wording: the report uses the constant, not the stored text', () => {
    const tampered = view()
    tampered.content = { ...tampered.content, label: 'These are chances of winning.' }
    const { markdown } = buildForecastReport({ matter, view: tampered })
    expect(markdown).toContain(forecastLabel)
    expect(markdown).not.toContain('These are chances of winning.')
  })
})
