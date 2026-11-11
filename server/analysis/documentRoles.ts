import type { RecordScope } from '../trialEngineTypes'
import type { EvidenceItem } from '../types'

// What kind of document a source is, for the case-intelligence features. The
// role says how the document can be used (a pleading holds allegations, not
// established facts), never whether its content is true.
export type DocumentRole = 'pleading' | 'transcript' | 'expert_report' | 'medical' | 'correspondence' | 'financial' | 'other'

export interface DocumentRoleResult {
  role: DocumentRole
  basis: 'record_scope' | 'title'
}

// A reviewed record-scope classification wins. Otherwise only the file name and
// the document's first line are read: a keyword deep in the body is weak signal.
// A heuristic: a wrong guess can be corrected by classifying the document in the
// case model's record scope.
export function documentRole(item: EvidenceItem, scope?: RecordScope): DocumentRoleResult {
  const classified = scope?.documents.find((entry) => entry.evidenceId === item.id)?.documentType
  if (classified && classified !== 'other') return { role: classified, basis: 'record_scope' }
  const firstLine = item.text.split('\n').find((line) => line.trim()) ?? ''
  const title = `${item.name} ${firstLine}`.toLowerCase().replace(/[_-]+/g, ' ')
  const rules: Array<[DocumentRole, RegExp]> = [
    ['pleading', /statement of (?:claim|defence|defense)|defence and (?:cross|counter)claim|\bcross ?claim\b|notice of action|\bpleading\b|\bjury notice\b/],
    ['transcript', /examination for discovery|discovery excerpt|\btranscript\b|\bdeposition\b/],
    ['expert_report', /\bexpert report\b|\bexpert opinion\b|orthopaedic report|orthopedic report|report of dr\.?|\bmedico.?legal\b|\bexpert\b.{0,40}\breport\b/],
    ['medical', /\bchart\b|emergency|hospital|physiotherapy|clinic|\bmedical\b|treatment records/],
    ['financial', /earnings|income summary|special damages|schedule of|\binvoice\b|\bpayroll\b/],
    ['correspondence', /\bletter\b|\bemail\b|\be-mail\b|\bmemo\b/],
  ]
  const found = rules.find(([, pattern]) => pattern.test(title))
  return { role: found ? found[0] : 'other', basis: 'title' }
}

// How a statement made in this kind of document is typed when a model has not
// said otherwise: pleadings assert allegations, transcripts record testimony.
export function sourceAssertion(role: DocumentRole): 'allegation' | 'testimony' | 'expert_opinion' | 'record' {
  if (role === 'pleading') return 'allegation'
  if (role === 'transcript') return 'testimony'
  if (role === 'expert_report') return 'expert_opinion'
  return 'record'
}
