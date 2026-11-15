import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { dateCandidatesForEvidence, extractDateCandidates, extractTimes, supportedDateParts } from '../server/analysis/dateCandidates'
import type { EvidenceItem } from '../server/types'

const sample = (name: string) => readFileSync(fileURLToPath(new URL(`../samples/civil-negligence/sources/${name}`, import.meta.url)), 'utf8').replace(/\r\n/g, '\n')
const first = (text: string) => extractDateCandidates(text)[0]

describe('code-first date candidates (F1)', () => {
  it('reads ISO dates, with and without a time', () => {
    expect(first('Seen on 2025-01-13.')).toMatchObject({ precision: 'day', start: '2025-01-13', original: '2025-01-13' })
    expect(first('2025-01-13 22:10 Plow and salt.')).toMatchObject({ precision: 'exact', start: '2025-01-13T22:10', time: '22:10' })
    expect(first('Logged 2025-01-13T08:05:30 by the guard.')).toMatchObject({ precision: 'exact', start: '2025-01-13T08:05' })
  })

  it('reads month-name dates in both orders, with ordinals and abbreviations', () => {
    expect(first('Issued November 3, 2025, by counsel.')).toMatchObject({ precision: 'day', start: '2025-11-03', original: 'November 3, 2025' })
    expect(first('Signed 3 March 2023.')).toMatchObject({ precision: 'day', start: '2023-03-03' })
    expect(first('Signed on the 3rd of March 2023.')).toMatchObject({ precision: 'day', start: '2023-03-03' })
    expect(first('Dec. 8, 2025')).toMatchObject({ precision: 'day', start: '2025-12-08' })
    expect(first('Sept 9, 2024')).toMatchObject({ precision: 'day', start: '2024-09-09' })
  })

  it('reads month-only and year-only dates at their own precision', () => {
    expect(first('Treatment began in March 2023.')).toMatchObject({ precision: 'month', start: '2023-03', original: 'March 2023' })
    expect(first('Employed since 2019.')).toMatchObject({ precision: 'year', start: '2019' })
  })

  it('does not read money, file numbers or counts as years', () => {
    expect(extractDateCandidates('Total: $2,025.00 and $2025 paid; file CV-23-00012345-0000; 20 hours; $84,000.')).toEqual([])
    expect(extractDateCandidates('Court file number CV-25-00000-FICT.')).toEqual([])
  })

  it('never guesses an ambiguous numeric date: it stays unknown with both readings and the original text', () => {
    const ambiguous = first('Received 04/05/2023 by mail.')
    expect(ambiguous).toMatchObject({ precision: 'unknown', original: '04/05/2023' })
    expect(ambiguous.start).toBeUndefined()
    expect(ambiguous.ambiguous?.readings.sort()).toEqual(['2023-04-05', '2023-05-04'])
    // Two-digit years are ambiguous about the century as well.
    expect(first('Dated 04/05/23.')).toMatchObject({ precision: 'unknown', original: '04/05/23' })
  })

  it('resolves a numeric date when only one reading is possible', () => {
    expect(first('Received 25/03/2023.')).toMatchObject({ precision: 'day', start: '2023-03-25' })
    expect(first('Received 03/25/2023.')).toMatchObject({ precision: 'day', start: '2023-03-25' })
    expect(first('Received 03/03/2023.')).toMatchObject({ precision: 'day', start: '2023-03-03' })
  })

  it('leaves an impossible calendar date unknown instead of rolling it over', () => {
    expect(first('Dated 2025-02-30.')).toMatchObject({ precision: 'unknown', original: '2025-02-30' })
    expect(first('Dated February 30, 2025.')).toMatchObject({ precision: 'unknown' })
  })

  it('marks approximate dates and times, and attaches a time that follows the date', () => {
    const claim = first('On January 14, 2025, at approximately 7:45 a.m., the Plaintiff fell.')
    expect(claim).toMatchObject({ precision: 'approximate', start: '2025-01-14T07:45', time: '07:45', approximate: true })
    expect(first('About March 3, 2023 we met.')).toMatchObject({ precision: 'approximate', start: '2023-03-03' })
    expect(first('Around 2019 it started.')).toMatchObject({ precision: 'approximate', start: '2019' })
    // A time with no am/pm keeps the 24 hour reading.
    expect(first('2025-01-14 at 22:10')).toMatchObject({ start: '2025-01-14T22:10' })
    expect(first('March 3, 2023 at 1:05 p.m.')).toMatchObject({ start: '2023-03-03T13:05' })
    expect(first('March 3, 2023 at 12:05 a.m.')).toMatchObject({ start: '2023-03-03T00:05' })
  })

  it('reads ranges as one candidate with a start and an end', () => {
    const employer = extractDateCandidates('The employee was absent from work from January 14, 2025 to October 19, 2025.')
    expect(employer.find((c) => c.precision === 'range')).toMatchObject({ start: '2025-01-14', end: '2025-10-19', original: 'January 14, 2025 to October 19, 2025' })
    const iso = extractDateCandidates('Records for treatment from 2025-04-02 to 2025-07-28 were held elsewhere.')
    expect(iso.find((c) => c.precision === 'range')).toMatchObject({ start: '2025-04-02', end: '2025-07-28' })
    const between = extractDateCandidates('No stops between 2025-01-13 22:48 and 2025-01-14 09:14.')
    expect(between.find((c) => c.precision === 'range')).toMatchObject({ start: '2025-01-13T22:48', end: '2025-01-14T09:14' })
    // "and" without "between" or "from" is not a range.
    expect(extractDateCandidates('On March 3, 2023 and March 9, 2023 he met them.').some((c) => c.precision === 'range')).toBe(false)
  })

  it('reads email Date: header lines and marks them as headers', () => {
    const mail = extractDateCandidates('From: a@example.test\nDate: Mon, 3 Mar 2023 10:15:00 -0500\nSubject: Update\n\nSee you March 9, 2023.')
    const header = mail.find((c) => c.kind === 'email_header')
    expect(header).toMatchObject({ precision: 'exact', start: '2023-03-03T10:15' })
    expect(mail.find((c) => c.start === '2023-03-09')?.kind).toBe('text')
    expect(extractDateCandidates('Date: March 3, 2023\nBody').find((c) => c.kind === 'email_header')).toMatchObject({ start: '2023-03-03' })
  })

  it('never uses file-modified or upload times', () => {
    const item = { id: 'e1', matterId: 'm', exhibitId: 'E-001', name: '2019-01-01-upload.txt', type: 'text', mimeType: 'text/plain', size: 10,
      text: 'No dates here at all.', summary: '', tags: [], uploadedAt: '2024-06-01T10:00:00.000Z', sha256: null, sourceAvailable: true,
      ingestionStatus: 'stored', extractionWarning: null, archivedAt: null } as EvidenceItem
    expect(dateCandidatesForEvidence(item)).toEqual([])
  })

  it('records the paragraph each candidate came from', () => {
    const item = { id: 'e1', matterId: 'm', exhibitId: 'E-001', name: 'a.txt', type: 'text', mimeType: 'text/plain', size: 10,
      text: 'First block on March 3, 2023.\n\nSecond block on 2024-05-06.', summary: '', tags: [], uploadedAt: '', sha256: null,
      sourceAvailable: true, ingestionStatus: 'stored', extractionWarning: null, archivedAt: null } as EvidenceItem
    expect(dateCandidatesForEvidence(item).map((c) => [c.paragraph, c.start])).toEqual([[1, '2023-03-03'], [2, '2024-05-06']])
  })

  it('extracts times as 24 hour HH:MM', () => {
    expect([...extractTimes('at approximately 7:45 a.m. and 08:05 and 1:30 pm and Triage 10:12')].sort()).toEqual(['07:45', '08:05', '10:12', '13:30'])
  })

  it('supports a date at its own precision and below, never above', () => {
    const parts = supportedDateParts(extractDateCandidates('Issued November 3, 2025. Treatment in March 2023. Employed since 2019.'))
    expect(parts.has('2025-11-03')).toBe(true)
    expect(parts.has('2025-11')).toBe(true)
    expect(parts.has('2025')).toBe(true)
    expect(parts.has('2023-03')).toBe(true)
    expect(parts.has('2023-03-14')).toBe(false)
    expect(parts.has('2019-06')).toBe(false)
    expect(parts.has('2019')).toBe(true)
  })

  it('does not support any date from an ambiguous candidate', () => {
    expect(supportedDateParts(extractDateCandidates('Received 04/05/2023.')).size).toBe(0)
  })

  it('finds the dates in the real fixture sources and nothing in a document without a date', () => {
    const claim = extractDateCandidates(sample('01-statement-of-claim.txt'))
    expect(claim.map((c) => c.start)).toEqual(expect.arrayContaining(['2025-11-03', '2025-01-14T07:45']))
    // The claim has no court-file or dollar false positives.
    expect(claim.some((c) => c.original.includes('CV-') || c.original.includes('$'))).toBe(false)
    const er = extractDateCandidates(sample('09-emergency-record.txt'))
    expect(er.map((c) => c.start).sort()).toEqual(['2025-01-16', '2025-01-19'])
    expect(extractDateCandidates(sample('04-jury-notice.txt')).length).toBeGreaterThan(0)
  })
})
