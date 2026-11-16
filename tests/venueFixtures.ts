import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { FrameworkService } from '../server/frameworks/service'
import type { CaseStore } from '../server/db'
import { VenueService } from '../server/venue/service'
import { civilWorld, type CivilWorld } from './civilFixtures'

// Everything here is fictional. The sample files are labelled as such and hold
// no real survey, census, court or verdict data.
const samples = resolve(fileURLToPath(new URL('../samples/venue-fictional/', import.meta.url)))

export const loadSample = <T = Record<string, unknown>>(name: string): T => JSON.parse(readFileSync(resolve(samples, name), 'utf8')) as T

export interface SampleAssumptions {
  assumptions: { responseRate: { low: number; central: number; high: number }; reporting: unknown[]; awardBandEdgesCents: number[] }
  seed: string
}
export const sampleAssumptions = (): SampleAssumptions => loadSample<SampleAssumptions>('assumptions-fictional.json')

export const fictionalEligibility = {
  criteria: [
    { id: 'citizen', label: 'Is a citizen (fictional criterion)', attribute: 'is_citizen' },
    { id: 'adult', label: 'Has reached the age of majority (fictional criterion)', attribute: 'is_adult' },
  ],
}

export interface VenueWorld extends CivilWorld {
  venue: VenueService
}

export function venueWorld(stores: CaseStore[] = []): VenueWorld {
  const world = civilWorld(undefined, stores)
  return { ...world, venue: new VenueService(world.store) }
}

// Chooses the Ontario pack for the matter and records a fictional eligibility
// rule as a matter-level override, the way a person would.
export function chooseEligibility(world: VenueWorld, value: unknown = fictionalEligibility): void {
  new FrameworkService(world.store).setForMatter(world.matterId, {
    packId: 'ontario_civil_2026_11', changedBy: 'Fictional Paralegal',
    overrides: [{ field: 'juryEligibility', status: 'known', value, reason: 'Fictional test criteria' }],
  })
}

export function importAll(world: VenueWorld, files = ['population-fictional.json', 'attitudes-fictional.json', 'focus-group-fictional.json', 'verdicts-fictional.json']) {
  return files.map((file) => world.venue.importDataset(world.matterId, loadSample(file)))
}

export function buildSampleProfile(world: VenueWorld, extra: Record<string, unknown> = {}) {
  const { assumptions, seed } = sampleAssumptions()
  return world.venue.buildProfile(world.matterId, { assumptions, seed, ...extra })
}

// ---------- protected-characteristic scan ----------
export const protectedKeyNames = [
  'age', 'gender', 'sex', 'race', 'ethnicity', 'religion', 'disability', 'nationality', 'orientation', 'maritalStatus', 'ageBand', 'ageGroup',
] as const
const protectedWord = /\b(?:age|aged|ages|elderly|young|younger|older|gender|sex|sexual|male|males|female|females|men|woman|women|race|races|racial|ethnic|ethnicity|nationality|immigrant|immigrants|religion|religious|christian|muslim|jewish|hindu|sikh|buddhist|disability|disabled|pregnant|marital|orientation|transgender)\b/i
const recommendation = /\b(?:strike|remove|exclude|avoid|dismiss|challenge|peremptory|favourable|unfavourable|favorable|unfavorable|recommend|recommended|keep|select|target)\b/i

// Every string and key in an output, with its path.
export function walk(value: unknown, path = '$'): Array<{ path: string; text: string; isKey: boolean }> {
  if (typeof value === 'string') return [{ path, text: value, isKey: false }]
  if (Array.isArray(value)) return value.flatMap((item, index) => walk(item, `${path}[${index}]`))
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, item]) => [{ path: `${path}.${key}`, text: key, isKey: true }, ...walk(item, `${path}.${key}`)])
  }
  return []
}

// No key may name a protected characteristic, and no string may put one next to
// a recommendation. `strict` also forbids the word anywhere in a value, for
// persona and sampler output.
export function protectedFindings(output: unknown, strict = false): string[] {
  const findings: string[] = []
  for (const { path, text, isKey } of walk(output)) {
    if (isKey && (protectedKeyNames as readonly string[]).some((name) => name.toLowerCase() === text.toLowerCase())) findings.push(`${path}: key names a protected characteristic`)
    if (!isKey && protectedWord.test(text) && (strict || recommendation.test(text))) findings.push(`${path}: ${text.slice(0, 80)}`)
  }
  return findings
}
