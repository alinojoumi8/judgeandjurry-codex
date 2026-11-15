import { describe, expect, it } from 'vitest'

import { datasetContentHash, DatasetImportError, validateDatasetImport, verifyStoredDataset } from '../server/venue/datasets'
import { loadSample } from './venueFixtures'

const base = { name: 'Fictional table', source: 'Fictional source', retrievedAt: '2026-11-08', licence: 'Fictional licence' }
const verdict = { court: 'Fictional court', year: 2020, claimType: 'fictional claim', outcome: 'plaintiff', awardCents: 100_000, sourceType: 'court_record' }

describe('dataset import validation', () => {
  it('accepts every fictional sample file and gives each row an id, a source and a licence', () => {
    for (const file of ['population-fictional.json', 'attitudes-fictional.json', 'focus-group-fictional.json', 'verdicts-fictional.json', 'verdicts-fictional-small.json']) {
      const dataset = validateDatasetImport(loadSample(file))
      expect(dataset.datasetHash).toMatch(/^[a-f0-9]{64}$/)
      dataset.rows.forEach((row, index) => {
        expect(row.id).toBe(`r${index + 1}`)
        expect(row.source.length).toBeGreaterThan(0)
        expect(row.licence.length).toBeGreaterThan(0)
      })
    }
  })

  it('refuses a dataset with no source, no licence or no retrieval date, and names each problem', () => {
    for (const field of ['source', 'licence', 'retrievedAt'] as const) {
      const input = { ...base, kind: 'verdict_observations', rows: [verdict], [field]: undefined }
      expect(() => validateDatasetImport(input)).toThrow(DatasetImportError)
      expect(() => validateDatasetImport(input)).toThrow(new RegExp(field))
    }
    expect(() => validateDatasetImport({ ...base, source: '   ', kind: 'verdict_observations', rows: [verdict] })).toThrow(/source/)
    expect(() => validateDatasetImport({ ...base, retrievedAt: '2026-02-30', kind: 'verdict_observations', rows: [verdict] })).toThrow(/real calendar date/)
  })

  it('refuses a row whose own source or licence is blank, and imports nothing', () => {
    const rows = [verdict, { ...verdict, source: '  ' }, { ...verdict, licence: '' }]
    try {
      validateDatasetImport({ ...base, kind: 'verdict_observations', rows })
      throw new Error('should have been refused')
    } catch (error) {
      expect(error).toBeInstanceOf(DatasetImportError)
      const problems = (error as DatasetImportError).problems
      expect(problems.some((problem) => /^Row 2 \(source\)/.test(problem))).toBe(true)
      expect(problems.some((problem) => /^Row 3 \(licence\)/.test(problem))).toBe(true)
    }
  })

  it('lets a row carry its own source and licence, which then replace the dataset\'s', () => {
    const dataset = validateDatasetImport({ ...base, kind: 'verdict_observations', rows: [{ ...verdict, source: 'Row source', licence: 'Row licence' }, verdict] })
    expect(dataset.rows[0]).toMatchObject({ source: 'Row source', licence: 'Row licence' })
    expect(dataset.rows[1]).toMatchObject({ source: 'Fictional source', licence: 'Fictional licence' })
  })

  it('refuses unknown fields, so a statistic cannot ride along on a row', () => {
    expect(() => validateDatasetImport({ ...base, kind: 'verdict_observations', rows: [{ ...verdict, winRate: 0.7 }] })).toThrow(/winRate|Unrecognized/i)
    expect(() => validateDatasetImport({ ...base, kind: 'verdict_observations', rows: [verdict], extra: 1 })).toThrow(DatasetImportError)
  })

  it('refuses an unknown kind, an empty dataset and a defence verdict carrying an award', () => {
    expect(() => validateDatasetImport({ ...base, kind: 'win_rates', rows: [verdict] })).toThrow(DatasetImportError)
    expect(() => validateDatasetImport({ ...base, kind: 'verdict_observations', rows: [] })).toThrow(/at least one row/)
    expect(() => validateDatasetImport({ ...base, kind: 'verdict_observations', rows: [{ ...verdict, outcome: 'defence', awardCents: 5 }] })).toThrow(/cannot carry an award/)
  })

  it('refuses an attitude that is not one of the closed list, so a protected characteristic cannot become a stratum', () => {
    const rows = [{ dimension: 'age', level: 'high', respondents: 40 }]
    expect(() => validateDatasetImport({ ...base, kind: 'attitude_survey', rows })).toThrow(DatasetImportError)
    expect(() => validateDatasetImport({ ...base, kind: 'attitude_survey', rows: [{ dimension: 'numeracy', level: 'high', respondents: 40 }] })).not.toThrow()
  })

  it('refuses focus-group text that names a protected characteristic, and accepts the same note without it', () => {
    const note = (finding: string) => ({ ...base, kind: 'focus_group', rows: [{ theme: 'Fictional theme', finding }] })
    expect(() => validateDatasetImport(note('Fictional older participants trusted experts more.'))).toThrow(/protected personal characteristic/)
    expect(() => validateDatasetImport(note('Women in the fictional group distrusted large awards.'))).toThrow(/protected personal characteristic/)
    expect(() => validateDatasetImport(note('Fictional participants wanted each expert\'s instructions disclosed.'))).not.toThrow()
  })

  it('refuses two survey rows for the same attitude and level', () => {
    const rows = [{ dimension: 'numeracy', level: 'high', respondents: 40 }, { dimension: 'numeracy', level: 'high', respondents: 10 }]
    expect(() => validateDatasetImport({ ...base, kind: 'attitude_survey', rows })).toThrow(/already appears/)
  })

  it('hashes what the data says, not what it is called', () => {
    const a = validateDatasetImport({ ...base, kind: 'verdict_observations', rows: [verdict] })
    const b = validateDatasetImport({ ...base, name: 'Another name', kind: 'verdict_observations', rows: [verdict] })
    const c = validateDatasetImport({ ...base, kind: 'verdict_observations', rows: [{ ...verdict, year: 2021 }] })
    expect(b.datasetHash).toBe(a.datasetHash)
    expect(c.datasetHash).not.toBe(a.datasetHash)
  })

  it('detects an altered stored dataset: a changed row, a lost licence or a wrong hash', () => {
    const dataset = validateDatasetImport({ ...base, kind: 'verdict_observations', rows: [verdict] })
    const stored = { kind: dataset.kind, source: dataset.source, retrievedAt: dataset.retrievedAt, licence: dataset.licence, rows: dataset.rows, datasetHash: dataset.datasetHash }
    expect(() => verifyStoredDataset(stored)).not.toThrow()
    expect(() => verifyStoredDataset({ ...stored, rows: [{ ...dataset.rows[0], year: 1999 }] })).toThrow(/hash/)
    expect(() => verifyStoredDataset({ ...stored, rows: [{ ...dataset.rows[0], licence: '' }] })).toThrow(/source or licence/)
    expect(() => verifyStoredDataset({ ...stored, datasetHash: datasetContentHash({ ...stored, rows: [] }) })).toThrow(/hash/)
  })
})
