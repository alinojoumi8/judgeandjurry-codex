import { createHash } from 'node:crypto'
import { z } from 'zod'

import { canonicalJson } from '../analysis/hash'
import { MAX_DATASET_ROWS } from './constants'
import { protectedTermIn, protectedTermMessage } from './protectedTerms'
import {
  attitudeDimensions, attitudeLevels, datasetKinds, verdictOutcomes, verdictSourceTypes,
  type DatasetKind, type DatasetRowMap,
} from './types'

// Datasets are user-supplied or curated inputs. There is no automatic web
// research (decision D4): nothing in this module fetches anything and nothing
// here calls a model. A row that lacks a source or a licence is refused.

const text = (max: number) => z.string().trim().min(1).max(max)
const optionalText = (label: string, max: number) => z.string().trim().min(1, `${label} must not be blank when given`).max(max).optional()
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a calendar date written YYYY-MM-DD')
  .refine((value) => new Date(`${value}T00:00:00Z`).toISOString().startsWith(value), 'must be a real calendar date')
const count = z.number().int().min(0).max(1_000_000_000)

// Row-level `source` and `licence` may refine the dataset's own; blank values are refused.
const provenanceFields = { source: optionalText('source', 2_000), licence: optionalText('licence', 500) }
const attributeKey = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/, 'must be lower-case letters, digits and underscores, starting with a letter')

const populationRow = z.object({
  ...provenanceFields,
  label: text(300),
  count,
  attributes: z.record(attributeKey, z.boolean()).default({}),
}).strict()

const attitudeRow = z.object({
  ...provenanceFields,
  dimension: z.enum(attitudeDimensions),
  level: z.enum(attitudeLevels),
  respondents: count,
}).strict()

const focusGroupRow = z.object({
  ...provenanceFields,
  theme: text(300),
  finding: text(4_000),
  dimension: z.enum(attitudeDimensions).optional(),
  participants: z.number().int().min(1).max(100_000).optional(),
}).strict()

const verdictRow = z.object({
  ...provenanceFields,
  court: text(300),
  year: z.number().int().min(1900).max(2100),
  claimType: text(300),
  outcome: z.enum(verdictOutcomes),
  awardCents: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
  sourceType: z.enum(verdictSourceTypes),
  citation: optionalText('citation', 2_000),
}).strict().superRefine((row, context) => {
  if (row.outcome === 'defence' && row.awardCents !== null && row.awardCents !== 0) {
    context.addIssue({ code: 'custom', path: ['awardCents'], message: 'a defence verdict cannot carry an award' })
  }
})

const rowSchemas = {
  population_table: populationRow,
  attitude_survey: attitudeRow,
  focus_group: focusGroupRow,
  verdict_observations: verdictRow,
} as const

export const datasetImportSchema = z.object({
  name: text(200),
  kind: z.enum(datasetKinds),
  source: text(2_000),
  retrievedAt: isoDate,
  licence: text(500),
  rows: z.array(z.unknown()).min(1, 'a dataset needs at least one row').max(MAX_DATASET_ROWS),
}).strict()
export type DatasetImportInput = z.infer<typeof datasetImportSchema>

export interface ValidatedDataset<K extends DatasetKind = DatasetKind> {
  name: string
  kind: K
  source: string
  retrievedAt: string
  licence: string
  rows: DatasetRowMap[K][]
  datasetHash: string
}

export class DatasetImportError extends Error {
  readonly problems: string[]

  constructor(problems: string[]) {
    super(`The dataset was not imported: ${problems.slice(0, 8).join(' ')}${problems.length > 8 ? ` (and ${problems.length - 8} more)` : ''}`)
    this.name = 'DatasetImportError'
    this.problems = problems
  }
}

// The hash covers what the dataset says (kind, source, date, licence, rows) and
// not its display name, so the same data is recognised wherever it is imported.
export function datasetContentHash(dataset: { kind: DatasetKind; source: string; retrievedAt: string; licence: string; rows: readonly unknown[] }): string {
  const { kind, source, retrievedAt, licence, rows } = dataset
  return createHash('sha256').update(canonicalJson({ kind, source, retrievedAt, licence, rows })).digest('hex')
}

// Validates the whole import before anything is stored. Every problem is
// reported with its row number; nothing is partially imported.
export function validateDatasetImport(input: unknown): ValidatedDataset {
  const header = datasetImportSchema.safeParse(input)
  if (!header.success) {
    throw new DatasetImportError(header.error.issues.map((issue) => `${issue.path.join('.') || 'dataset'}: ${issue.message}.`))
  }
  const { name, kind, source, retrievedAt, licence } = header.data
  const schema = rowSchemas[kind]
  const problems: string[] = []
  const rows: Array<Record<string, unknown>> = []
  header.data.rows.forEach((raw, index) => {
    const parsed = schema.safeParse(raw)
    if (!parsed.success) {
      for (const issue of parsed.error.issues) problems.push(`Row ${index + 1}${issue.path.length ? ` (${issue.path.join('.')})` : ''}: ${issue.message}.`)
      return
    }
    const row = parsed.data as Record<string, unknown>
    const freeText = kind === 'focus_group' ? [String(row.theme), String(row.finding)] : []
    for (const value of freeText) {
      const term = protectedTermIn(value)
      if (term) problems.push(`Row ${index + 1}: the text ${protectedTermMessage(term)}`)
    }
    rows.push({ id: `r${index + 1}`, ...row, source: row.source ?? source, licence: row.licence ?? licence })
  })
  if (kind === 'attitude_survey') {
    // A dimension needs at least one respondent in some level.
    const seen = new Map<string, string>()
    for (const [index, row] of rows.entries()) {
      const key = `${String(row.dimension)}:${String(row.level)}`
      if (seen.has(key)) problems.push(`Row ${index + 1}: ${String(row.dimension)} at level ${String(row.level)} already appears in row ${seen.get(key)?.slice(1)}. Give one row per attitude and level.`)
      else seen.set(key, String(row.id))
    }
  }
  if (problems.length) throw new DatasetImportError(problems)
  const typedRows = rows as unknown as DatasetRowMap[typeof kind][]
  return { name, kind, source, retrievedAt, licence, rows: typedRows, datasetHash: datasetContentHash({ kind, source, retrievedAt, licence, rows: typedRows }) }
}

// Stored rows are checked again on read and on archive import: they must still
// parse, carry a source and licence, and hash to the recorded value.
export function verifyStoredDataset(dataset: { kind: DatasetKind; source: string; retrievedAt: string; licence: string; rows: unknown; datasetHash: string }): void {
  if (!Array.isArray(dataset.rows)) throw new Error('rows are not a list')
  const schema = rowSchemas[dataset.kind]
  for (const [index, row] of dataset.rows.entries()) {
    const record = row as Record<string, unknown>
    const { id, ...rest } = record
    if (id !== `r${index + 1}`) throw new Error(`row ${index + 1} has an unexpected id`)
    if (typeof rest.source !== 'string' || !rest.source.trim() || typeof rest.licence !== 'string' || !rest.licence.trim()) {
      throw new Error(`row ${index + 1} has no source or licence`)
    }
    if (!schema.safeParse(rest).success) throw new Error(`row ${index + 1} is not valid for a ${dataset.kind} dataset`)
  }
  if (datasetContentHash({ ...dataset, rows: dataset.rows }) !== dataset.datasetHash) throw new Error('its rows do not match its recorded hash')
}
