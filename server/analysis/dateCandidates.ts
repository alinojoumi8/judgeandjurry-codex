import { sourceParagraphs } from '../grounding'
import type { EvidenceItem } from '../types'

// Code-first candidate dates for the chronology (plan F1). This is a
// deterministic reader of document text. It never looks at file names, upload
// times or any file-modified time, and it never guesses: a numeric date that
// could be day-first or month-first stays unknown, with both readings and the
// original text kept. Dates without a year are not resolved at all.

export type DatePrecision = 'exact' | 'day' | 'month' | 'year' | 'range' | 'approximate' | 'unknown'

export interface DateCandidate {
  paragraph: number
  // The exact text read, including an attached time.
  original: string
  precision: DatePrecision
  // ISO text at the candidate's own precision: YYYY, YYYY-MM, YYYY-MM-DD or YYYY-MM-DDTHH:MM.
  start?: string
  end?: string
  approximate: boolean
  // 24 hour HH:MM, when a time was attached to the date. Time zones are not read.
  time?: string
  kind: 'text' | 'email_header'
  // Set when a numeric date has more than one possible reading.
  ambiguous?: { readings: string[] }
  // True for the two endpoints of a range candidate.
  inRange?: boolean
  // Offset of the match inside its paragraph, for ordering.
  index: number
}

const monthNames: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7,
  aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
}
const monthPattern = 'Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sept?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?'
const timePattern = String.raw`(\d{1,2}):(\d{2})(?::\d{2})?(?:\s*([ap])\.?\s*m\.?)?(?!\d)`

const pad = (value: number, width = 2) => String(value).padStart(width, '0')

function validDay(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
  return day <= days
}

function monthNumber(name: string): number {
  return monthNames[name.toLowerCase().replace('.', '')]
}

function clock(hour: number, minute: number, meridiem?: string): string | undefined {
  if (minute > 59) return undefined
  let value = hour
  if (meridiem) {
    if (hour < 1 || hour > 12) return undefined
    value = (hour % 12) + (meridiem.toLowerCase() === 'p' ? 12 : 0)
  } else if (hour > 23) return undefined
  return `${pad(value)}:${pad(minute)}`
}

// Every distinct 24 hour HH:MM clock time in the text.
export function extractTimes(text: string): Set<string> {
  const times = new Set<string>()
  for (const match of text.matchAll(new RegExp(String.raw`(?<![\d:])${timePattern}`, 'gi'))) {
    const value = clock(Number(match[1]), Number(match[2]), match[3])
    if (value) times.add(value)
  }
  return times
}

interface Raw {
  index: number
  end: number
  precision: DatePrecision
  start?: string
  ambiguous?: { readings: string[] }
  // Date forms a time may follow.
  timeable: boolean
}

const approxBefore = new RegExp(String.raw`(?:\b(?:approx(?:imately|\.)?|about|around|circa|roughly)|~)\s+(?:(?:on|in|at|the)\s+)*$`, 'i')

// Candidate dates in one paragraph of text.
export function extractDateCandidates(text: string, paragraph = 1): DateCandidate[] {
  const raws: Raw[] = []
  const consumed: Array<[number, number]> = []
  const free = (index: number, end: number) => consumed.every(([a, b]) => end <= a || index >= b)
  const take = (raw: Raw) => {
    if (!free(raw.index, raw.end)) return
    consumed.push([raw.index, raw.end])
    raws.push(raw)
  }
  const unknown = (index: number, end: number): Raw => ({ index, end, precision: 'unknown', timeable: false })

  // 1. ISO dates, with or without a time.
  for (const match of text.matchAll(/(?<![\d-])(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::\d{2})?)?(?!\d)/g)) {
    const [whole, y, m, d, hh, mm] = match
    const index = match.index
    if (!validDay(Number(y), Number(m), Number(d))) { take(unknown(index, index + whole.length)); continue }
    const time = hh === undefined ? undefined : clock(Number(hh), Number(mm))
    if (hh !== undefined && !time) { take({ index, end: index + whole.length, precision: 'day', start: `${y}-${m}-${d}`, timeable: false }); continue }
    take({ index, end: index + whole.length, precision: time ? 'exact' : 'day', start: time ? `${y}-${m}-${d}T${time}` : `${y}-${m}-${d}`, timeable: !time })
  }

  // 2. Month-name dates: "March 3, 2023" and "3 March 2023".
  const named: Array<{ regex: RegExp; read: (m: RegExpMatchArray) => [string, string, string] }> = [
    { regex: new RegExp(String.raw`\b(${monthPattern})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})(?!\d)`, 'gi'), read: (m) => [m[3], m[1], m[2]] },
    { regex: new RegExp(String.raw`(?<!\d)(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(${monthPattern})\.?,?\s+(\d{4})(?!\d)`, 'gi'), read: (m) => [m[3], m[2], m[1]] },
  ]
  for (const { regex, read } of named) {
    for (const match of text.matchAll(regex)) {
      const [y, monthName, d] = read(match)
      const month = monthNumber(monthName)
      const index = match.index
      const end = index + match[0].length
      if (!validDay(Number(y), month, Number(d))) take(unknown(index, end))
      else take({ index, end, precision: 'day', start: `${y}-${pad(month)}-${pad(Number(d))}`, timeable: true })
    }
  }

  // 3. Numeric dates: never guessed when both readings are possible.
  for (const match of text.matchAll(/(?<![\d/.-])(\d{1,2})([/.-])(\d{1,2})\2(\d{2}|\d{4})(?![\d/-])/g)) {
    const [whole, a, , b, yearText] = match
    const index = match.index
    const end = index + whole.length
    const first = Number(a)
    const second = Number(b)
    if (yearText.length === 2) { take({ ...unknown(index, end), ambiguous: { readings: [] } }); continue }
    const year = Number(yearText)
    const iso = (month: number, day: number) => (validDay(year, month, day) ? `${yearText}-${pad(month)}-${pad(day)}` : undefined)
    const dayFirst = iso(second, first)
    const monthFirst = iso(first, second)
    if (first === second || !dayFirst || !monthFirst) {
      const only = first === second ? dayFirst : dayFirst ?? monthFirst
      if (only) take({ index, end, precision: 'day', start: only, timeable: true })
      else take(unknown(index, end))
    } else {
      take({ index, end, precision: 'unknown', ambiguous: { readings: [dayFirst, monthFirst] }, timeable: false })
    }
  }
  for (const match of text.matchAll(/(?<![\d/])(\d{4})\/(\d{1,2})\/(\d{1,2})(?![\d/])/g)) {
    const [whole, y, m, d] = match
    const end = match.index + whole.length
    if (validDay(Number(y), Number(m), Number(d))) take({ index: match.index, end, precision: 'day', start: `${y}-${pad(Number(m))}-${pad(Number(d))}`, timeable: true })
    else take(unknown(match.index, end))
  }

  // 4. Month and year: "March 2023". A capital letter keeps the verb "may" out.
  for (const match of text.matchAll(new RegExp(String.raw`\b(${monthPattern})\.?,?\s+(\d{4})(?![\d,/-])`, 'g'))) {
    take({ index: match.index, end: match.index + match[0].length, precision: 'month', start: `${match[2]}-${pad(monthNumber(match[1]))}`, timeable: false })
  }

  // 5. A year on its own. Money, counts, file numbers and larger numbers are not years.
  for (const match of text.matchAll(/(?<![\d$,.#/-])((?:19|20)\d{2})(?![\d,/-]|\.\d)/g)) {
    take({ index: match.index, end: match.index + match[0].length, precision: 'year', start: match[1], timeable: false })
  }

  raws.sort((a, b) => a.index - b.index)

  const headers = [...text.matchAll(/^[ \t]*Date:[ \t]*(.*)$/gim)].map((line) => [line.index, line.index + line[0].length] as const)
  const candidates: DateCandidate[] = raws.map((raw) => {
    const lineEnd = text.indexOf('\n', raw.end)
    const tail = text.slice(raw.end, lineEnd === -1 ? text.length : Math.min(lineEnd, raw.end + 60))
    let { start, precision } = raw
    let end = raw.end
    let time: string | undefined
    let approximate = approxBefore.test(text.slice(Math.max(0, raw.index - 30), raw.index))
    if (raw.start && raw.timeable) {
      const attached = tail.match(new RegExp(String.raw`^,?\s*(?:at|@)?\s*(?:(approx(?:imately|\.)?|about|around)\s+)?${timePattern}`, 'i'))
      if (attached) {
        const value = clock(Number(attached[2]), Number(attached[3]), attached[4])
        if (value) {
          time = value
          start = `${raw.start}T${value}`
          precision = 'exact'
          end = raw.end + attached[0].length
          approximate ||= attached[1] !== undefined
        }
      }
    } else if (raw.start && raw.precision === 'exact') {
      time = raw.start.slice(11)
    }
    if (approximate && start) precision = 'approximate'
    return {
      paragraph, original: text.slice(raw.index, end), precision: raw.start ? precision : 'unknown', start: raw.start ? start : undefined,
      approximate: approximate && Boolean(start), time, kind: headers.some(([a, b]) => raw.index >= a && raw.index < b) ? 'email_header' : 'text',
      ...(raw.ambiguous ? { ambiguous: raw.ambiguous } : {}), index: raw.index,
    }
  })

  // Ranges: "A to B", "from A and B" never; "between A and B" and "from A to B" only.
  const ranges: DateCandidate[] = []
  for (let i = 0; i + 1 < candidates.length; i += 1) {
    const a = candidates[i]
    const b = candidates[i + 1]
    const aEnd = a.index + a.original.length
    const gap = text.slice(aEnd, b.index)
    const joined = /^\s*(?:to|through|until|till|–|—|-)\s*$/i.test(gap)
      || (/^\s*and\s*$/i.test(gap) && /\b(?:between|from)\s+$/i.test(text.slice(Math.max(0, a.index - 12), a.index)))
    if (!joined) continue
    a.inRange = true
    b.inRange = true
    const known = a.start !== undefined && b.start !== undefined
    ranges.push({
      paragraph, original: text.slice(a.index, b.index + b.original.length), precision: known ? 'range' : 'unknown',
      start: known ? a.start : undefined, end: known ? b.start : undefined, approximate: a.approximate || b.approximate,
      kind: a.kind, index: a.index,
    })
    i += 1
  }
  return [...candidates, ...ranges].sort((x, y) => x.index - y.index || (x.precision === 'range' ? -1 : 1))
}

// Candidate dates in every paragraph of one document, using the same paragraph
// numbers as the source check. Text only: nothing here reads file metadata.
export function dateCandidatesForEvidence(item: EvidenceItem): DateCandidate[] {
  return sourceParagraphs(item).flatMap((part) => extractDateCandidates(part.text, part.paragraph))
}

// The date strings a model may claim. A day supports its month and year, a
// month supports its year, and nothing supports a finer date than was written.
// An ambiguous candidate supports nothing.
export function supportedDateParts(candidates: readonly DateCandidate[]): Set<string> {
  const parts = new Set<string>()
  for (const candidate of candidates) {
    if (candidate.ambiguous) continue
    for (const value of [candidate.start, candidate.end]) {
      if (!value) continue
      if (value.length >= 10) parts.add(value.slice(0, 10))
      if (value.length >= 7) parts.add(value.slice(0, 7))
      parts.add(value.slice(0, 4))
    }
  }
  return parts
}
