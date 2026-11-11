import { formatBps, formatCents, parseDollarsToCents, parsePercentToBps } from '../../../server/damages/format'
import { damagesInputsSchemaVersion, type DamagesInputs } from '../../../server/damages/types'

// The inputs form as text, and the conversion to and from the stored inputs. Money is typed as dollars and becomes whole cents;
// a rate is typed as a percentage and becomes whole basis points. Anything that is not an amount is an error shown to the person,
// never a guess. A field left blank stays "not entered" (unknown): it is never turned into zero.

export type Tri = 'unknown' | 'none' | 'entered'
export interface FormLine { label: string; amount: string }
export interface ClaimedRow { low: string; likely: string; high: string; note: string; document: string; paragraph: string; quote: string }

export interface DamagesForm {
  claimed: Record<string, ClaimedRow>
  fault: { status: 'unknown' | 'entered'; percent: string }
  policyLimit: { status: Tri; amount: string }
  deductions: { status: Tri; lines: FormLine[] }
  interest: { status: Tri; kind: 'simple' | 'compound'; rate: string; periods: string }
  liens: { status: Tri; lines: FormLine[] }
  fees: { status: Tri; percent: string; fixed: string }
  collectability: { status: 'unknown' | 'entered'; percent: string; assets: string }
  perDiemDays: string
  counter: Record<string, string>
}

const blankRow = (): ClaimedRow => ({ low: '', likely: '', high: '', note: '', document: '', paragraph: '', quote: '' })
const dollars = (cents: number | null | undefined) => (cents === null || cents === undefined ? '' : formatCents(cents).replace('$', ''))

export function formFromInputs(inputs: DamagesInputs, categoryIds: readonly string[]): DamagesForm {
  const claimed: Record<string, ClaimedRow> = {}
  for (const id of categoryIds) claimed[id] = blankRow()
  for (const item of inputs.claimed) {
    const source = item.sources[0]
    claimed[item.categoryId] = { low: dollars(item.lowCents), likely: dollars(item.likelyCents), high: dollars(item.highCents), note: item.note ?? '', document: source?.evidenceId ?? '', paragraph: source ? String(source.paragraph) : '', quote: source?.quote ?? '' }
  }
  const counter: Record<string, string> = {}
  for (const item of inputs.defenceCounterAnchors) counter[item.categoryId] = dollars(item.cents)
  const lines = (list: Array<{ label: string; cents: number }>): FormLine[] => list.map((line) => ({ label: line.label, amount: dollars(line.cents) }))
  const { claimantFault: fault, policyLimit, deductions, interest, liens, fees, collectability } = inputs
  return {
    claimed,
    fault: fault.status === 'entered' ? { status: 'entered', percent: formatBps(fault.value.bps).replace('%', '') } : { status: 'unknown', percent: '' },
    policyLimit: policyLimit.status === 'entered' ? { status: 'entered', amount: dollars(policyLimit.value.limitCents) } : { status: policyLimit.status, amount: '' },
    deductions: { status: deductions.status, lines: deductions.status === 'entered' ? lines(deductions.value) : [] },
    interest: interest.status === 'entered'
      ? { status: 'entered', kind: interest.value.kind, rate: formatBps(interest.value.rateBps).replace('%', ''), periods: String(interest.value.periods) }
      : { status: interest.status, kind: 'simple', rate: '', periods: '' },
    liens: { status: liens.status, lines: liens.status === 'entered' ? lines(liens.value) : [] },
    fees: fees.status === 'entered'
      ? { status: 'entered', percent: fees.value.percentBps === undefined ? '' : formatBps(fees.value.percentBps).replace('%', ''), fixed: dollars(fees.value.fixedCents) }
      : { status: fees.status, percent: '', fixed: '' },
    collectability: collectability.status === 'entered'
      ? { status: 'entered', percent: collectability.value.percentBps === undefined ? '' : formatBps(collectability.value.percentBps).replace('%', ''), assets: dollars(collectability.value.assetCapCents) }
      : { status: 'unknown', percent: '', assets: '' },
    perDiemDays: inputs.perDiemDays === null ? '' : String(inputs.perDiemDays),
    counter,
  }
}

export interface FormResult { inputs: DamagesInputs | null; errors: string[] }

export function inputsFromForm(form: DamagesForm, currency: string, labels: Readonly<Record<string, string>>): FormResult {
  const errors: string[] = []
  const money = (text: string, what: string): number | null => {
    if (text.trim() === '') return null
    const cents = parseDollarsToCents(text)
    if (cents === null) errors.push(`${what}: enter dollars and cents, such as 12,500.00.`)
    return cents
  }
  const percent = (text: string, what: string): number | null => {
    if (text.trim() === '') return null
    const bps = parsePercentToBps(text)
    if (bps === null) errors.push(`${what}: enter a percentage from 0 to 100 with at most two decimals.`)
    return bps
  }
  const lines = (list: FormLine[], what: string) => list.flatMap((line, index) => {
    if (line.label.trim() === '' && line.amount.trim() === '') return []
    const cents = money(line.amount, `${what} line ${index + 1}`)
    if (line.label.trim() === '') errors.push(`${what} line ${index + 1}: describe it.`)
    return cents === null ? [] : [{ id: `line-${index + 1}`, label: line.label.trim() || `Line ${index + 1}`, cents }]
  })
  const claimed: DamagesInputs['claimed'] = []
  for (const [categoryId, row] of Object.entries(form.claimed)) {
    const name = labels[categoryId] ?? categoryId
    const low = money(row.low, `${name}, low`)
    const likely = money(row.likely, `${name}, likely`)
    const high = money(row.high, `${name}, high`)
    const hasSource = row.quote.trim() !== ''
    if (hasSource && (row.document === '' || !/^\d+$/.test(row.paragraph.trim()))) errors.push(`${name}: a cited passage needs a document and a paragraph number.`)
    if (low === null && likely === null && high === null && !hasSource && row.note.trim() === '') continue
    claimed.push({
      categoryId, lowCents: low, likelyCents: likely, highCents: high, ...(row.note.trim() ? { note: row.note.trim() } : {}),
      sources: hasSource && row.document !== '' && /^\d+$/.test(row.paragraph.trim()) ? [{ evidenceId: row.document, paragraph: Number(row.paragraph.trim()), quote: row.quote.trim() }] : [],
    })
  }
  const counter: DamagesInputs['defenceCounterAnchors'] = []
  for (const [categoryId, text] of Object.entries(form.counter)) {
    const cents = money(text, `${labels[categoryId] ?? categoryId}, defence counter-anchor`)
    if (cents !== null) counter.push({ categoryId, cents })
  }
  const triple = <T,>(status: Tri, build: () => T | null): { status: 'unknown' } | { status: 'none' } | { status: 'entered'; value: T } => {
    if (status === 'unknown') return { status: 'unknown' }
    if (status === 'none') return { status: 'none' }
    const value = build()
    return value === null ? { status: 'unknown' } : { status: 'entered', value }
  }
  const fault = form.fault.status === 'entered' ? percent(form.fault.percent, 'Claimant fault') : null
  if (form.fault.status === 'entered' && form.fault.percent.trim() === '') errors.push('Claimant fault: enter a percentage (0 if you assume none), or choose "Not entered".')
  const policy = triple(form.policyLimit.status, () => { const cents = money(form.policyLimit.amount, 'Policy limit'); return cents === null ? null : { limitCents: cents } })
  if (form.policyLimit.status === 'entered' && policy.status !== 'entered') errors.push('Policy limit: enter the limit, or choose another option.')
  const deductions = triple(form.deductions.status, () => { const list = lines(form.deductions.lines, 'Deduction'); return list.length ? list : null })
  if (form.deductions.status === 'entered' && deductions.status !== 'entered') errors.push('Deductions: add at least one line, or choose another option.')
  const interest = triple(form.interest.status, () => {
    const rate = percent(form.interest.rate, 'Interest rate')
    const periods = /^\d+$/.test(form.interest.periods.trim()) ? Number(form.interest.periods.trim()) : null
    if (periods === null) errors.push('Interest: enter a whole number of periods.')
    return rate === null || periods === null ? null : { kind: form.interest.kind, rateBps: rate, periods }
  })
  if (form.interest.status === 'entered' && interest.status !== 'entered' && form.interest.rate.trim() === '') errors.push('Interest: enter a rate per period.')
  const liens = triple(form.liens.status, () => { const list = lines(form.liens.lines, 'Lien'); return list.length ? list : null })
  if (form.liens.status === 'entered' && liens.status !== 'entered') errors.push('Liens: add at least one line, or choose another option.')
  const fees = triple(form.fees.status, () => {
    const pct = percent(form.fees.percent, 'Fee percentage')
    const fixed = money(form.fees.fixed, 'Fixed fee')
    return pct === null && fixed === null ? null : { ...(pct === null ? {} : { percentBps: pct }), ...(fixed === null ? {} : { fixedCents: fixed }) }
  })
  if (form.fees.status === 'entered' && fees.status !== 'entered') errors.push('Fees: enter a percentage, a fixed fee, or both.')
  let collectability: DamagesInputs['collectability'] = { status: 'unknown' }
  if (form.collectability.status === 'entered') {
    const pct = percent(form.collectability.percent, 'Collectable share')
    const assets = money(form.collectability.assets, 'Collectible assets')
    if (pct === null && assets === null) errors.push('Collectability: enter a percentage, an amount of collectible assets, or both.')
    else collectability = { status: 'entered', value: { ...(pct === null ? {} : { percentBps: pct }), ...(assets === null ? {} : { assetCapCents: assets }) } }
  }
  let perDiemDays: number | null = null
  if (form.perDiemDays.trim() !== '') {
    if (/^\d+$/.test(form.perDiemDays.trim()) && Number(form.perDiemDays.trim()) >= 1) perDiemDays = Number(form.perDiemDays.trim())
    else errors.push('Per-diem days: enter a whole number of days, 1 or more.')
  }
  if (errors.length) return { inputs: null, errors }
  return {
    errors,
    inputs: {
      schemaVersion: damagesInputsSchemaVersion, currency, claimed,
      claimantFault: fault === null ? { status: 'unknown' } : { status: 'entered', value: { bps: fault } },
      policyLimit: policy, deductions, interest, liens, fees, collectability, perDiemDays, defenceCounterAnchors: counter,
    } as DamagesInputs,
  }
}
