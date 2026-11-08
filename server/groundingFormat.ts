import type { GroundingReview, GroundingUnit } from './grounding'

export const groundingToolName = 'record_grounding_review'
export const groundingRepairToolName = 'repair_grounding_units'
export const groundingSupportTypes = ['source', 'record', 'own_assessment', 'instruction', 'source_use', 'analysis', 'coherence'] as const
export const groundingSupportTypesContract = 'supportTypes must be a nonempty JSON array of unique allowed strings, never an object, scalar or null. Each item must itself be one literal JSON string; never put objects, arrays or key/value mappings inside the array. For example, a heading uses ["analysis"], and mixed source/analysis uses ["source","analysis"]. Choose domains independently from the actual claim; these examples establish no support or judgment.'

export const groundingSourceUseContract = 'Application coverage and omitted-file notes describe only what this run supplies; they are not words of an affidavit or proof that a document does not exist. Independently classify a supported coverage/limited-weight assessment as analysis with the applicable source_use/analysis domains, rather than supported source content without citations. Use actual supplied coverage; missing coverage supplies no absence fact. Every separate assertion about a source or the underlying event still needs its actual permitted source support. Never relabel an unsupported factual premise to avoid that check.'

export function checkerCorrectionFeedback(units: GroundingUnit[], review: GroundingReview, arrayFindings = false, singleFinding = false): string {
  const rows = units.map(unit => ({ unitId: unit.id, recordCitations: [], citations: [], supportTypes: [unit.kind ? 'coherence' : 'analysis'], status: 'unsupported', explanation: 'Replace with one short independent assessment.' }))
  const skeleton = singleFinding ? { unitId: rows[0].unitId, recordCitations: JSON.stringify(rows[0].recordCitations), citations: rows[0].citations, supportTypes: rows[0].supportTypes, status: rows[0].status, explanation: rows[0].explanation } : { findings: arrayFindings ? rows : Object.fromEntries(rows.map(({ unitId, ...row }) => [unitId, row])) }
  const selected = Object.fromEntries(review.findings.map(f => [f.unitId, f.citations.map(c => ({ exhibitId: c.exhibitId, paragraph: c.paragraph }))]))
  const itemErrors = review.findings.flatMap(finding => Array.isArray(finding.supportTypes) ? finding.supportTypes.flatMap((value, index) => {
    if (typeof value === 'string') return []
    const kind = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
    return [`${finding.unitId}.supportTypes[${index}] must be a literal allowed JSON string; received ${kind}. Independently reassess the support domains for the SAME draft. Do not convert an object key into a domain, remove an item to hide its failure, or supply a default.`]
  }) : [])
  return `Your previous verification failed deterministic validation. Re-check the SAME draft units against the actual sources; prior judgments are not evidence. Preserve every substantive rejection. ${groundingSupportTypesContract} ${groundingSourceUseContract}${itemErrors.length ? `\nInvalid supportTypes array items:\n${itemErrors.join('\n')}` : ''}\n${review.errors.join('\n')}\nRequired finding slots as a complete JSON skeleton (replace statuses, support domains and explanations independently): ${JSON.stringify(skeleton)}\n${singleFinding ? 'Return one complete finding object in this order: unitId, recordCitations, citations, supportTypes, status and explanation, without a findings wrapper or array. Independently select record references first and return recordCitations as a JSON-encoded array string, including the literal string "[]" when none apply; other array fields remain arrays. An omitted recordCitations field is not an empty selection; never copy a skeleton value without checking the supplied record.' : arrayFindings ? 'Use a flat findings array. Each row has unitId and exactly the five finding fields; no duplicate IDs, root-level rows, omitted rows, continuation fragments or prose.' : 'Use exactly the five row fields inside findings; no root-level rows, inner unitId, omitted rows, continuation fragments or prose.'} Keep each explanation to one short sentence. Do not put paragraph numbers in explanation; structured citations already carry the exact paragraph. Do not copy erroneous paragraph numbers from feedback. Previously resolved selectors (not a judgment or new evidence): ${JSON.stringify(selected)}. Select actual supporting passages independently; never invent or remap a paragraph. Locator shape examples only: ${JSON.stringify({citations:[{exhibitId:"COPY actual exhibit",paragraph:1}],recordCitations:singleFinding ? JSON.stringify([{eventId:"COPY actual visible reference"}]) : [{eventId:"COPY actual visible reference"}]})}. The example values are not selectors; use only actual supplied references, and ${singleFinding ? 'the encoded string "[]" for recordCitations ([] for citations)' : '[]'} if none apply. Each locator entry must be an object, never a string. Use analysis for valid non-source domains, not supported. JSON or paragraph correction must not reverse a factual rejection just to pass.`
}

export function checkerSchemaFailure(review: GroundingReview): boolean {
  const errors = review.validationErrors ?? []
  // A missing unit also gets a conservative unsupported status. Do not mistake
  // that placeholder for a malformed status returned for an actual finding.
  const substantive = review.findings.some(finding => ['unsupported', 'contradicted'].includes(finding.status) && finding.explanation.trim() && !errors.includes(`${finding.unitId}: a valid finding status is required.`))
  return !substantive && errors.some(error => error.startsWith('Exact finding ID inventory:')) || errors.some(error => /^(?:Invalid JSON|Invalid findings schema)$/.test(error) || /: (?:ballot consistency requires|invalid support types|non-source support requires|checker explanation paragraph reference|checker changed judgment on unchanged text)/.test(error)) ||
    !errors.some(error => error.startsWith('Exact finding ID inventory:')) && errors.some(error => /: a valid finding status is required\.$/.test(error))
}

// This is an output channel, never a tool with external side effects. MiniMax
// supports tool schemas; its JSON response_format mode is not assumed.
export function groundingTool(units: GroundingUnit[], references?: { records: string[]; exhibits: string[]; peerRecords?: Record<string, string[]> }) {
  const jointIds = units.filter(unit => unit.kind === 'ballot_consistency').map(unit => unit.id)
  const finding = (coherence: boolean, unitId: string) => {
    const records = references?.peerRecords?.[unitId] ?? references?.records
    const row = {
    type: 'object', additionalProperties: false, required: ['status', 'supportTypes', 'explanation', 'citations', 'recordCitations'], properties: {
      status: { type: 'string', enum: coherence ? ['analysis', 'contradicted', 'unsupported'] : ['supported', 'analysis', 'contradicted', 'unsupported'], description: 'supported requires source support. Use analysis for valid record attribution, own assessment/history, instructions, source-use restrictions or premise-free evaluation. Reject unsupported premises regardless of domain.' },
      supportTypes: { type: 'array', description: 'Required on unsupported and contradicted findings too; independently select the applicable domains before writing the judgment. ' + groundingSupportTypesContract, minItems: 1, ...(coherence ? { maxItems: 1 } : {}), uniqueItems: true, items: { type: 'string', description: 'One literal JSON string chosen independently from this enum. Never emit an object, nested array, null or a key/value mapping as an item.', enum: coherence ? ['coherence'] : groundingSupportTypes.filter(type => type !== 'coherence') } },
      explanation: { type: 'string', description: 'One short sentence assessing this claim. Do not include paragraph numbers; put exact paragraph selectors only in citations. Do not copy a previous judgment as evidence.' },
      citations: { type: 'array', ...(coherence ? { maxItems: 0 } : {}), description: 'Source selectors. Use [] when none apply; never a string or null.', items: { type: 'object', additionalProperties: false, required: ['exhibitId', 'paragraph'], properties: {
        exhibitId: { type: 'string', ...(references?.exhibits.length ? { enum: references.exhibits } : {}) }, paragraph: { type: 'integer', minimum: 1 },
      } } },
      recordCitations: { type: 'array', description: 'Visible record selectors. Select the actual named peer, not a record whose number resembles a juror number. Use [] when none apply; never a string or null.', ...(coherence || records && !records.length ? { maxItems: 0 } : {}), items: { type: 'object', additionalProperties: false, required: ['eventId'], properties: { eventId: { type: 'string', ...(records?.length ? { enum: records } : {}) } } } },
    },
    }
    // Select the support and references before writing any judgment, including
    // negative rows. Missing selections remain missing, never inferred defaults.
    const properties = { recordCitations: row.properties.recordCitations, citations: row.properties.citations, supportTypes: row.properties.supportTypes, status: row.properties.status, explanation: row.properties.explanation }
    return { ...row, required: Object.keys(properties), properties }
  }
  // Required keyed slots avoid asking the provider to reconstruct an array's
  // identity inventory. Keep one row shape; saved array reviews remain readable.
  const coherence = jointIds.length ? ` For ${jointIds.join(', ')}, use supportTypes ["coherence"], status analysis/contradicted/unsupported, and empty citations and recordCitations arrays.` : ''
  return { type: 'function', function: {
    name: groundingToolName,
    description: 'Record the independent source check of every supplied draft unit exactly once. Return the full findings inventory, never an empty object. Every row requires supportTypes, including unsupported and contradicted findings, plus status, explanation, citations and recordCitations.' + coherence,
    parameters: { type: 'object', additionalProperties: false, required: ['findings'], properties: {
      findings: { type: 'object', additionalProperties: false, minProperties: units.length, maxProperties: units.length, required: units.map(unit => unit.id), properties: Object.fromEntries(units.map(unit => [unit.id, finding(unit.kind === 'ballot_consistency', unit.id)])) },
    } },
  } }
}

// Scope a same-draft correction only when the prior raw keyed inventory is
// complete and every failure is attached to a known unit. No parsed fallback
// value is reused as a model assessment.
export function groundingCorrectionUnits(units: GroundingUnit[], review: GroundingReview, content: string): GroundingUnit[] {
  try {
    const data = JSON.parse(content)
    if (!completeKeyedFindings(data, units) || !review.errors.length) return units
    // A complete inventory with missing fields in accepted rows can be corrected
    // without asking the model to regenerate every other raw assessment.
    const missing = units.filter(unit => review.errors.some(error =>
      ['status', 'supportTypes', 'explanation', 'citations', 'recordCitations'].some(field =>
        error === `${unit.id}.${field} is required; return an independently assessed value.`)))
    if (missing.length && missing.every(unit => {
      const row = data.findings[unit.id] as Record<string, unknown> | null
      return row && (row.status === 'analysis' || row.status === 'supported')
    }) && review.errors.every(error =>
      error === 'The checker returned an invalid keyed findings schema. Preserve each required key and all five finding fields.' ||
      error === `Malformed finding rows: ${JSON.stringify(missing.map(unit => unit.id))}. Include exactly status, supportTypes, explanation, citations and recordCitations, with nonempty explanation and valid selectors.` ||
      missing.some(unit => ['status', 'supportTypes', 'explanation', 'citations', 'recordCitations'].some(field =>
        error === `${unit.id}.${field} is required; return an independently assessed value.`)))) return missing
    if (
      review.errors.some(error => !units.some(unit => error.startsWith(unit.id + ':')))) return units
    const failed = units.filter(unit => review.errors.some(error => error.startsWith(unit.id + ':')))
    return failed.length ? failed : units
  } catch { return units }
}

function completeKeyedFindings(data: unknown, units: GroundingUnit[]): data is { findings: Record<string, unknown> } {
  if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).length !== 1 || !('findings' in data)) return false
  const findings = data.findings
  return Boolean(findings && typeof findings === 'object' && !Array.isArray(findings) &&
    Object.keys(findings).length === units.length && units.every(unit => Object.hasOwn(findings, unit.id)))
}

export function mergeGroundingCorrection(previous: string, correction: string, units: GroundingUnit[], targets: GroundingUnit[]): string {
  const base = JSON.parse(previous), next = JSON.parse(correction)
  if (!targets.length || !targets.every(target => units.some(unit => unit.id === target.id)) || !completeKeyedFindings(base, units) || !completeKeyedFindings(next, targets)) {
    throw new Error('The scoped correction requires exactly its requested finding IDs and no extra root fields; no missing row is inferred.')
  }
  // Retain explicit raw rows, never normalized statuses, default fields or new
  // selectors. The entire combined record still undergoes the strict parser.
  return JSON.stringify({ findings: { ...base.findings, ...next.findings } })
}

// A uniform correction row avoids the dynamic nested slots that some tool
// responses flatten incorrectly. The same exact inventory and validators apply.
export function groundingCorrectionTool(units: GroundingUnit[], references: { records: string[]; exhibits: string[]; peerRecords?: Record<string, string[]> }) {
  const tool = groundingTool([{ id: 'row', text: '' }], { ...references, peerRecords: units.length === 1 ? { row: references.peerRecords?.[units[0].id] ?? references.records } : undefined })
  const row = tool.function.parameters.properties.findings.properties.row
  return { type: 'function', function: { ...tool.function,
    parameters: { type: 'object', additionalProperties: false, required: ['findings'], properties: {
      findings: { type: 'array', minItems: units.length, maxItems: units.length, items: {
        ...row, required: ['unitId', ...row.required], properties: {
          unitId: { type: 'string', enum: units.map(unit => unit.id), description: 'Copy this row identity first from the supplied unit inventory. Required on EVERY row; never infer identity from array order or omit it after the first row.' },
          ...row.properties,
          supportTypes: { ...row.properties.supportTypes, items: { ...row.properties.supportTypes.items, enum: groundingSupportTypes } },
        },
      } },
    } },
  } }
}

export function groundingCorrectionContent(content: string): string {
  const data = JSON.parse(content)
  if (!Array.isArray(data?.findings)) return content
  const ids = new Set<string>()
  const rows = data.findings.map((row: Record<string, unknown>) => {
    if (!row || typeof row !== 'object' || Array.isArray(row) || typeof row.unitId !== 'string' || ids.has(row.unitId)) {
      throw new Error('The correction requires complete finding objects with explicit unique unitId values.')
    }
    ids.add(row.unitId)
    const { unitId, ...finding } = row
    return [unitId, finding]
  })
  // Preserve unexpected root/row fields for strict keyed-schema rejection.
  // This is an exact representation conversion, never syntax or selector repair.
  return JSON.stringify({ ...data, findings: Object.fromEntries(rows) })
}

// A scalar transport avoids provider XML-to-tool conversion splitting nested
// arrays/objects into $text/item fragments. Decode only explicit model output;
// do not rebuild fragmented rows, infer IDs, or fill absent selections.
export function groundingSerializedTool(units: GroundingUnit[]) {
  return { type: 'function', function: {
    name: groundingToolName,
    description: 'Deliver the complete independent review as a JSON-encoded string in reviewJson. Do not expose nested finding objects as tool parameters.',
    parameters: { type: 'object', additionalProperties: false, required: ['reviewJson'], properties: {
      reviewJson: { type: 'string', description: `A complete JSON object obeying the inner response contract for these exact IDs: ${JSON.stringify(units.map(unit => unit.id))}. Include every field and locator object explicitly. Encode the whole object as a string; no prose or fragments.` },
    } },
  } }
}

export function groundingSerializedContent(content: string): string {
  const data = JSON.parse(content)
  if (data && typeof data === 'object' && Object.hasOwn(data, 'reviewJson')) {
    if (Object.keys(data).length !== 1 || typeof data.reviewJson !== 'string') throw new Error('reviewJson must be the only tool field and contain the complete review as a JSON string.')
    // Validate syntax here; all inventory, field, selector and semantic checks
    // still run on the decoded content through the existing review parser.
    JSON.parse(data.reviewJson)
    return data.reviewJson
  }
  return content // Preserved older tool representations still face strict checks.
}

// One-unit corrections need no array or dynamic-key nesting in tool arguments.
// Preserve the explicit identity and every returned value, including omissions.
export function groundingSingleTool(units: GroundingUnit[], references: { records: string[]; exhibits: string[]; peerRecords?: Record<string, string[]> }) {
  if (units.length !== 1) throw new Error('A single-finding correction requires exactly one supplied unit.')
  const tool = groundingCorrectionTool(units, references)
  const row = tool.function.parameters.properties.findings.items
  // Ask for the explicit record selection before the assessment. Empty arrays
  // are still model output, never defaults inferred from the reference inventory.
  const properties = {
    unitId: row.properties.unitId,
    recordCitations: { type: 'string', description: 'Required JSON-encoded array of independently selected record locator objects. Return the literal string "[]" when no visible record supports this claim. For a selection encode [{"eventId":"actual supplied reference"}]. Never omit the field or use an empty string, null, a default, or an invented reference. Allowed references: ' + JSON.stringify(references.records) },
    citations: row.properties.citations,
    supportTypes: row.properties.supportTypes,
    status: row.properties.status,
    explanation: row.properties.explanation,
  }
  return { ...tool, function: { ...tool.function,
    description: 'Return one complete finding object as tool arguments in this order: unitId, recordCitations, citations, supportTypes, status and explanation. Independently select record references first, encoding the array as a JSON string, explicitly including the string "[]" when none apply. Other array fields remain arrays. Do not wrap it in findings or omit fields.',
    parameters: { ...row, required: Object.keys(properties), properties },
  } }
}

export function groundingSingleContent(content: string): string {
  const data = JSON.parse(content)
  if (data && typeof data === 'object' && !Array.isArray(data) && !Object.hasOwn(data, 'findings') && typeof data.unitId === 'string') {
    const { unitId, ...finding } = data
    // Decode only an explicit model selection. Missing fields remain missing;
    // the full review parser validates every locator and permitted reference.
    if (typeof finding.recordCitations === 'string') {
      const selected = JSON.parse(finding.recordCitations)
      if (!Array.isArray(selected)) throw new Error('recordCitations must encode a JSON array of record locators.')
      finding.recordCitations = selected
    }
    return JSON.stringify({ findings: { [unitId]: finding } })
  }
  // Complete historical representations still undergo the same strict keyed
  // validation; no absent ID or required metadata is filled from the request.
  return groundingCorrectionContent(content)
}

export function groundingRepairTool(unitIds: string[]) {
  if (!unitIds.length) throw new Error('Source repair has no rejected text unit to edit.')
  return { type: 'function', function: {
    name: groundingRepairToolName,
      description: 'Replace only the listed rejected units. A listed ballot-choice target permits crown, defence or mixed; preserve all other metadata and every accepted unit.',
    parameters: { type: 'object', additionalProperties: false, required: ['repairs'], properties: {
      repairs: { type: 'array', minItems: 1, maxItems: unitIds.length, items: {
        type: 'object', additionalProperties: false, required: ['unitId', 'replacement'], properties: {
          unitId: { type: 'string', enum: unitIds }, replacement: { type: 'string', description: 'Corrected text, or an empty string to remove this rejected unit.' },
        },
      } },
    } },
  } }
}

// These acknowledgements contain no assessment, selector or source premise.
// Unknown prose and competing review JSON remain invalid output channels.
const neutralCheckerAcknowledgements = new Set([
  "i'll audit each unit against the supplied sources.",
  "i'll audit each unit against the permitted sources and record.",
  "i'll audit each unit against the permitted sources before recording findings.",
  'i will audit each unit against the supplied sources.',
  'here is the source review:',
  'here is the independent source review:',
])

export function groundingToolContent(message: { content?: string | null; tool_calls?: unknown }, expectedName = groundingToolName): string | undefined {
  if (message.tool_calls === undefined) return undefined // Legacy compatible text responses still undergo full validation.
  if (!Array.isArray(message.tool_calls) || message.tool_calls.length !== 1) throw new Error(`Expected exactly one ${expectedName} tool response.`)
  const call = message.tool_calls[0]
  const preamble = message.content?.trim().replaceAll('’', "'").toLowerCase()
  const neutral = expectedName === groundingToolName && Boolean(preamble && (neutralCheckerAcknowledgements.has(preamble) ||
    /^i(?:'ll| will) audit each (?:supplied )?unit(?: now| against the (?:(?:actual )?supplied|permitted|actual) (?:sources|source record|record))\.$/.test(preamble)))
  if (call?.type !== 'function' || call.function?.name !== expectedName || typeof call.function.arguments !== 'string' || preamble && !neutral) {
    throw new Error(`Expected only the named ${expectedName} tool arguments, without competing message content.`)
  }
  return call.function.arguments
}
