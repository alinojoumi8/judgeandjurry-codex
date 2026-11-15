import { afterEach, describe, expect, it } from 'vitest'

import { DamagesError } from '../server/analysis/damages'
import { damagesInputsHash, damagesInputsSchema, emptyDamagesInputs, inputProblems } from '../server/damages/inputs'
import { latestInputs } from '../server/damages/store'
import type { DamagesInputs } from '../server/damages/types'
import type { CaseStore } from '../server/db'
import { categoriesOnly, damagesWorld, evidenceText, fullInputs } from './damagesFixtures'

const stores: CaseStore[] = []
afterEach(() => { for (const store of stores.splice(0)) store.close() })

const parse = (change: Record<string, unknown>) => damagesInputsSchema.safeParse({ ...fullInputs(), ...change })

describe('damages inputs: validated whole cents and basis points, never a float', () => {
  it('accepts a complete set (the valid control) and the empty set where nothing is known', () => {
    expect(damagesInputsSchema.safeParse(fullInputs()).success).toBe(true)
    expect(damagesInputsSchema.safeParse(emptyDamagesInputs()).success).toBe(true)
  })

  it.each([
    ['a fractional amount', { claimed: [{ categoryId: 'general', lowCents: 100.5, likelyCents: null, highCents: null, sources: [] }] }],
    ['a negative amount', { claimed: [{ categoryId: 'general', lowCents: -1, likelyCents: null, highCents: null, sources: [] }] }],
    ['low above likely', { claimed: [{ categoryId: 'general', lowCents: 500, likelyCents: 100, highCents: null, sources: [] }] }],
    ['likely above high', { claimed: [{ categoryId: 'general', lowCents: null, likelyCents: 500, highCents: 100, sources: [] }] }],
    ['a category entered twice', { claimed: [{ categoryId: 'general', lowCents: 1, likelyCents: 2, highCents: 3, sources: [] }, { categoryId: 'general', lowCents: 1, likelyCents: 2, highCents: 3, sources: [] }] }],
    ['fault over 100%', { claimantFault: { status: 'entered', value: { bps: 10_001 } } }],
    ['fault stated as "none" (it is a value, 0 or more, or unknown)', { claimantFault: { status: 'none' } }],
    ['fees with neither a percentage nor an amount', { fees: { status: 'entered', value: {} } }],
    ['collectability stated as "none"', { collectability: { status: 'none' } }],
    ['a negative lien', { liens: { status: 'entered', value: [{ id: 'l', label: 'x', cents: -5 }] } }],
    ['a currency that is not three capital letters', { currency: 'cad' }],
    ['an unknown extra key', { surprise: true }],
    ['compound interest with a fractional number of periods', { interest: { status: 'entered', value: { kind: 'compound', rateBps: 100, periods: 1.5 } } }],
  ])('refuses %s', (_name, change) => {
    expect(parse(change as Record<string, unknown>).success).toBe(false)
  })

  it('hashes the same content to the same value whatever the key order, and changes the hash when anything changes', () => {
    const inputs = fullInputs()
    const reordered = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(inputs).reverse()))) as DamagesInputs
    expect(damagesInputsHash(reordered)).toBe(damagesInputsHash(inputs))
    expect(damagesInputsHash({ ...inputs, perDiemDays: 30 })).not.toBe(damagesInputsHash(inputs))
    expect(damagesInputsHash(inputs)).toMatch(/^[a-f0-9]{64}$/)
  })

  it('names a category or currency the court rules do not have', () => {
    expect(inputProblems(fullInputs(), ['past_income', 'general'], 'CAD')).toEqual([])
    expect(inputProblems({ ...fullInputs(), currency: 'USD' }, ['past_income', 'general'], 'CAD')).toEqual(['The inputs are in USD, but the chosen court rules state amounts in CAD.'])
    expect(inputProblems(fullInputs(), ['past_income'], 'CAD')[0]).toMatch(/names "general", which is not a damages category/)
  })
})

describe('saving inputs as a versioned, hash-verified artifact', () => {
  it('saves a new version only when something changed, and reloads it with its hash', () => {
    const world = damagesWorld(stores)
    expect(world.damages.inputsView(world.matterId)).toMatchObject({ version: null, status: null, inputsHash: null, currency: 'CAD' })
    const first = world.damages.saveInputs(world.matterId, fullInputs())
    expect(first).toMatchObject({ version: 1, status: 'draft', inputsHash: damagesInputsHash(fullInputs()) })
    expect(world.damages.saveInputs(world.matterId, fullInputs()).version).toBe(1)
    const second = world.damages.saveInputs(world.matterId, { ...fullInputs(), perDiemDays: 30 })
    expect(second.version).toBe(2)
    expect(second.inputs.perDiemDays).toBe(30)
    expect(latestInputs(world.store, world.matterId)!.artifact.version).toBe(2)
    expect(world.damages.versions(world.matterId).versions.filter((entry) => entry.kind === 'inputs')).toHaveLength(2)
  })

  it('lists what is not entered, in plain words, with where each thing comes from, and never as zero', () => {
    const world = damagesWorld(stores)
    const view = world.damages.inputsView(world.matterId)
    // The rules here state the order, caps, collateral benefits and interest, so what is missing is what only the person can enter.
    expect(view.missing.map((item) => [item.stepId, item.where])).toEqual([
      ['fault', 'your_input'], ['deductions', 'your_input'], ['interest', 'your_input'], ['liens', 'your_input'], ['fees', 'your_input'], ['policyLimit', 'your_input'], ['collectability', 'your_input'],
    ])
    expect(view.missing[0]!.say).toContain('Enter the claimant fault assumption (use 0% if you assume none)')
    // Where the rules themselves are silent, the note says the rules are what is missing.
    const silent = damagesWorld(stores, { rules: categoriesOnly() })
    const notes = silent.damages.inputsView(silent.matterId).missing
    expect(notes.map((item) => [item.stepId, item.where])).toEqual([
      ['order', 'court_rules'], ['caps', 'court_rules'], ['fault', 'your_input'], ['deductions', 'court_rules'], ['interest', 'court_rules'], ['liens', 'your_input'], ['fees', 'your_input'], ['policyLimit', 'your_input'], ['collectability', 'your_input'],
    ])
    expect(notes[0]!.say).toMatch(/Calculation order unknown/)
    expect(notes[1]!.say).toContain('do not state the damages caps (unknown, which is not none and not zero)')
    // The valid control: with everything entered, nothing is missing.
    const complete = damagesWorld(stores)
    expect(complete.damages.saveInputs(complete.matterId, fullInputs()).missing).toEqual([])
  })

  it('refuses a claimed amount whose source passage is not in the document, and names the source', () => {
    const world = damagesWorld(stores)
    const claimed = (quote: string, paragraph = 1) => ({ ...fullInputs(), claimed: [{ categoryId: 'past_income', lowCents: null, likelyCents: 4_000_000, highCents: null, sources: [{ evidenceId: world.evidenceId, paragraph, quote }], note: 'Fictional wage loss.' }] })
    const quote = 'lost 40,000 dollars of wages'
    expect(() => world.damages.saveInputs(world.matterId, claimed('lost 90,000 dollars of wages', 2))).toThrow(DamagesError)
    expect(() => world.damages.saveInputs(world.matterId, claimed('lost 90,000 dollars of wages', 2))).toThrow(/Claimed amount "past_income", source 1: .*does not appear in that paragraph/)
    expect(() => world.damages.saveInputs(world.matterId, claimed(quote, 9))).toThrow(/has no paragraph 9/)
    expect(() => world.damages.saveInputs(world.matterId, { ...claimed(quote, 2), claimed: [{ ...claimed(quote, 2).claimed[0]!, sources: [{ evidenceId: 'not-evidence', paragraph: 2, quote }] }] })).toThrow(/not part of this matter's current evidence/)
    expect(world.damages.inputsView(world.matterId).version).toBeNull()
    // The valid control: the right quotation in the right paragraph is saved.
    expect(evidenceText).toContain(quote)
    expect(world.damages.saveInputs(world.matterId, claimed(quote, 2)).version).toBe(1)
  })

  it('refuses a category the court rules do not name, a different currency, and any claimed amount while the categories are unknown', () => {
    const world = damagesWorld(stores)
    expect(() => world.damages.saveInputs(world.matterId, { ...fullInputs(), claimed: [{ categoryId: 'invented', lowCents: 1, likelyCents: 2, highCents: 3, sources: [] }] })).toThrow(/names "invented", which is not a damages category/)
    expect(() => world.damages.saveInputs(world.matterId, { ...fullInputs(), currency: 'USD' })).toThrow(/in USD, but the chosen court rules state amounts in CAD/)
    const unknown = damagesWorld(stores, { rules: [] })
    expect(() => unknown.damages.saveInputs(unknown.matterId, fullInputs())).toThrow(/do not state the damages categories yet/)
    // Valid control: inputs that need no category are saved even then.
    expect(unknown.damages.saveInputs(unknown.matterId, { ...emptyDamagesInputs(), fees: { status: 'entered', value: { percentBps: 1000 } } }).version).toBe(1)
  })

  it('refuses a stored version whose hash no longer matches its content', () => {
    const inputs = fullInputs()
    const fake = { analysis: { list: () => [{ content: { inputs, inputsHash: '0'.repeat(64) }, version: 1, status: 'draft' }] } }
    expect(() => latestInputs(fake as never, 'm')).toThrow(/do not match their recorded hash/)
    const honest = { analysis: { list: () => [{ content: { inputs, inputsHash: damagesInputsHash(inputs) }, version: 1, status: 'draft' }] } }
    expect(latestInputs(honest as never, 'm')!.inputsHash).toBe(damagesInputsHash(inputs))
  })
})
