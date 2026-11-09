import { listCuratedAuthorities } from '../authorityRegistry'
import { blockers, ruleKeys, ruleLabels, type RuleKey } from '../frameworks/schema'
import type { MatterFrameworkView } from '../frameworks/service'
import { normalize } from '../grounding'
import { frameworkInstructionSections, getProcedureAdapter } from '../procedureAdapters'
import type { ProcedureAdapterId } from '../trialEngineTypes'
import type { ApprovedAuthority, NeedsResearch } from './caseSummaryTypes'

// Law comes from approved sources, never from a model's memory (plan section 4,
// rule 3). The approved list for a summary is the chosen court rules' authorities,
// the curated instruction sections of the matter's procedure, and the curated
// authority registry. Everything a model says about law is checked against it.

const placeholderTitle = 'Matter-level override'

const isCase = (title: string) => /\bv\.?\s/.test(title)

export interface ApprovedSources {
  authorities: ApprovedAuthority[]
  courtRules: { selected: boolean; packId?: string; unreviewed: boolean; notice: string }
  // Research gaps found by code. Nothing here is a model's guess.
  needsResearch: NeedsResearch[]
}

export function buildApprovedAuthorities(
  rules: MatterFrameworkView, adapterId: ProcedureAdapterId | undefined, needs: { damages: boolean; punitive: boolean },
): ApprovedSources {
  const authorities: ApprovedAuthority[] = []
  const research: NeedsResearch[] = []
  const addResearch = (section: NeedsResearch['section'], topic: string, reason: string) =>
    research.push({ id: `nr-code-${research.length + 1}`, section, topic, reason, origin: 'code' })

  if (adapterId) {
    const adapter = getProcedureAdapter(adapterId)
    const sections = adapterId === 'ontario_civil_v1' && rules.selected && rules.framework ? frameworkInstructionSections(rules.framework) : adapter.instructionSections
    for (const section of sections) {
      authorities.push({
        id: `instruction:${section.id}`, origin: 'procedure_adapter', kind: 'instruction', title: section.title, citation: section.title,
        url: section.sourceUrl, text: section.text, reviewStatus: 'unreviewed',
        note: 'Curated procedure text. The procedure\'s sources require lawyer review.',
      })
    }
    // The registry holds criminal-procedure entries (bail and pleas). They are
    // approved for criminal matters and are not offered as precedent for a civil one.
    if (adapterId !== 'ontario_civil_v1') {
      for (const entry of listCuratedAuthorities()) {
        authorities.push({
          id: `registry:${entry.id}`, origin: 'authority_registry', kind: entry.sourceKind === 'court-decision' ? 'case' : 'statute',
          title: entry.title, citation: entry.citation, url: entry.sourceUrl, summary: entry.summary, reviewStatus: 'unreviewed', note: entry.note,
        })
      }
    }
  }

  if (rules.selected && rules.pack) {
    const merged = new Map<string, ApprovedAuthority>()
    for (const key of ruleKeys) {
      const rule = rules.pack.rules[key]
      for (const authority of rule.authorities) {
        if (authority.title === placeholderTitle) continue
        const existing = merged.get(authority.title)
        const reviewed = rule.reviewStatus === 'reviewed'
        if (!existing) {
          merged.set(authority.title, {
            id: `pack:${merged.size + 1}`, origin: 'rule_pack', kind: isCase(authority.title) ? 'case' : 'statute', title: authority.title,
            citation: authority.title, pinpoint: authority.pinpoint, ...(authority.url ? { url: authority.url } : {}),
            ruleLabel: ruleLabels[key], ruleStatus: rule.status, reviewStatus: reviewed ? 'reviewed' : 'unreviewed',
            ...(rule.toBeConfirmed ? { toBeConfirmed: true } : {}), ...(rule.note ? { note: rule.note } : {}),
          })
        } else {
          if (!existing.pinpoint?.split('; ').includes(authority.pinpoint)) existing.pinpoint = `${existing.pinpoint ?? ''}; ${authority.pinpoint}`.replace(/^; /, '')
          if (!existing.ruleLabel?.split('; ').includes(ruleLabels[key])) existing.ruleLabel = `${existing.ruleLabel ?? ''}; ${ruleLabels[key]}`.replace(/^; /, '')
          if (rule.status === 'known') existing.ruleStatus = 'known'
          if (!reviewed) existing.reviewStatus = 'unreviewed'
          if (rule.toBeConfirmed) existing.toBeConfirmed = true
        }
      }
    }
    authorities.push(...merged.values())

    const wanted: RuleKey[] = ['juryAvailability', 'verdictForm']
    if (needs.damages) wanted.push('damagesCaps')
    if (needs.punitive) wanted.push('punitiveAvailability', 'punitiveStandard')
    for (const blocker of blockers(rules.pack, wanted)) {
      addResearch('expected_instructions', blocker.label, `The chosen court rules do not state this (${blocker.reason}). Unknown is not treated as none, so the instruction on it needs research.`)
    }
  } else {
    addResearch('expected_instructions', 'Court rules', 'No court rules are chosen for this case, so the expected instructions are the general procedure text only. Choose court rules in Overview, then generate again.')
  }
  if (!authorities.some((authority) => authority.kind === 'case')) {
    addResearch('precedent', 'Precedent', 'No case law is on the approved list for this matter, so no precedent is stated. A lawyer needs to find and verify authorities for each claim.')
  }

  return {
    authorities,
    courtRules: { selected: rules.selected, ...(rules.pack ? { packId: rules.pack.id } : {}), unreviewed: rules.unreviewed, notice: rules.reviewNotice },
    needsResearch: research,
  }
}

// ---------------------------------------------------------------------------
// The allow-list check

const norm = (text: string) => ` ${text.normalize('NFKC').toLowerCase().replace(/\bsections?\b/g, 's').replace(/[^a-z0-9]+/g, ' ').trim()} `

const name = String.raw`[A-Z][\w'’&.-]*`
const joiner = String.raw`(?:of|and|&|the|${name})`
const patterns: RegExp[] = [
  // A case name: "Smith v. Jones Holdings".
  new RegExp(String.raw`\b${name}(?:\s+${joiner}){0,5}\s+v\.?\s+(?:the\s+)?${name}(?:\s+${joiner}){0,5}`, 'g'),
  // Neutral citations and reporter citations.
  /\b(?:19|20)\d{2}\s+(?:SCC|ONCA|ONSC|ONCJ|BCCA|BCSC|BCPC|ABCA|ABQB|ABKB|SKCA|SKQB|MBCA|MBQB|QCCA|NBCA|NSCA|PECA|NLCA|FCA|FC|SCR|CanLII|HRTO)\s+\d{1,5}\b/g,
  /\[\d{4}\]\s+\d+\s+[A-Z][A-Za-z.]*\s+\d+/g,
  /\(\d{4}\),?\s+\d+\s+O\.?R\.?\s*(?:\(\d[a-z]{1,2}\))?\s*\d+/g,
  // A statute, code or regulation by name, and consolidated citations.
  /\b(?:[A-Z][A-Za-z'’&-]*\s+){1,6}(?:Act|Code)\b/g,
  /\b(?:R\.S\.[OC]\.|S\.[OC]\.|R\.S\.)\s*\d{4}(?:,\s*c\.\s*[A-Z0-9.-]+)?/g,
  /\b(?:Reg\.|Regulation)\s*\d+(?:\/\d+)?/g,
  // A pinpoint to a provision or a rule.
  /\bss?\.\s*\d+(?:\.\d+)?(?:\s*\([0-9A-Za-z]+\))*/g,
  /\bsections?\s+\d+(?:\.\d+)?(?:\s*\([0-9A-Za-z]+\))*(?=\s+of\s+the\s+[A-Z])/gi,
  /\bRules?\s+\d{1,3}(?:\.\d+)?\b/g,
]
const leadingWords = new Set(['the', 'this', 'that', 'these', 'those', 'an', 'a', 'any', 'each', 'under', 'per', 'see', 'in', 'on', 'of', 'and', 'at', 'for', 'to', 'by', 'with'])
const trailingWords = new Set(['the', 'of', 'and', '&'])

// Strips words the capitalised-run patterns pick up around a name ("The
// Negligence Act", "... Holdings Inc. the"), and drops a bare "Act" or "Code"
// that names nothing.
function cleaned(mention: string): string {
  const parts = mention.trim().split(/\s+/)
  while (parts.length > 1 && leadingWords.has(parts[0].toLowerCase())) parts.shift()
  while (parts.length > 1 && trailingWords.has(parts[parts.length - 1].toLowerCase())) parts.pop()
  const result = parts.join(' ')
  return /^(?:act|code)$/i.test(result) ? '' : result
}

export function authorityMentions(text: string): string[] {
  const found = new Set<string>()
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const mention = cleaned(match[0])
      if (mention) found.add(mention)
    }
  }
  return [...found]
}

export interface AuthorityAllowList {
  // Everything an approved authority names, normalised. Whole-token matching only.
  haystack: string
}

export function allowListFor(authorities: readonly ApprovedAuthority[], caption: string): AuthorityAllowList {
  const parts = authorities.flatMap((authority) => [authority.title, authority.citation, authority.pinpoint ?? ''])
  return { haystack: norm([caption, ...parts].join(' | ')) }
}

// Legal authorities a text names that are not approved. A mention that sits
// inside one of the sentence's own cited quotations describes the record (a
// pleading that names a statute), so it is not an assertion of law. Returns
// the mentions that are neither.
export function unapprovedAuthorities(text: string, quotes: readonly string[], allow: AuthorityAllowList): string[] {
  const quoted = norm(quotes.map((quote) => normalize(quote)).join(' | '))
  return authorityMentions(text).filter((mention) => {
    const needle = norm(mention)
    return !allow.haystack.includes(needle) && !quoted.includes(needle)
  })
}
