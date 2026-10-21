import type { EvidenceItem } from './types'

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const prose = (value: string) => value.normalize('NFKC').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/"[^"\n]*"/g, ' ')

export function resolvedCurrentCrownProof(text: string): boolean {
  const findings = /\bI (?:am|'m) (?:satisfied|convinced) beyond (?:a )?reasonable doubt\b|\b(?:credit|find|conclude)\b[^.!?;]{0,160}\bbeyond (?:a )?reasonable doubt\b|\b(?:Crown (?:has )?(?:met|satisfied) (?:its|the) (?:proof )?burden|Crown['’]s burden (?:is |has been )?(?:met|satisfied))\b/gi
  return prose(text).split(/(?<=[.!?;])\s+/).some(sentence => {
    if (sentence.trim().endsWith('?') || /\b(?:if|would|could|might)\b/i.test(sentence) ||
        /^(?:It is incorrect|It is not true) to say\b/i.test(sentence.trim())) return false
    return [...sentence.matchAll(findings)].some(match => {
      const leading = sentence.slice(0, match.index)
      const prefix = leading.split(/\b(?:but|however|yet|and|whereas)\b|[,;]/i).at(-1) ?? ''
      if (/^(?:credit|find|conclude)\b/i.test(match[0]) && !/\bI\b/i.test(prefix)) {
        const inherited = leading.split(/\b(?:but|however|yet|whereas)\b|;/i).at(-1) ?? ''
        if (!/\bI\b/i.test(leading) || /\b(?:whether|uncertain|unsure|not|never|don't|cannot|can't)\b/i.test(inherited)) return false
      }
      return !/\b(?:not|never|don't|cannot|can't)\s*(?:personally\s*)?$|\b(?:fail|failed) to\s*$/i.test(prefix) &&
        !/\b(?:whether|(?:not true|not established|incorrect to say)(?: that)?)\b[^.!?;]*$/i.test(prefix) &&
        !/\b(?:doubt|uncertain|unsure|not satisfied|not convinced) (?:about )?that\b[^.!?;]*$/i.test(prefix)
    })
  })
}

// Retained doubt needs a resolved current proof assessment, not a magic phrase
// or a numerical confidence cutoff. Ordinary residual doubt may coexist with
// an explicit independent proof finding under the supplied standard.
export function unresolvedCrownProofDoubt(text: string, crownSelection = false): boolean {
  const sentences = prose(text).split(/(?<=[.!?;])\s+/).filter(sentence =>
    !sentence.trim().endsWith('?') && !/\b(?:if|would|could|might)\b/i.test(sentence) &&
    !/^(?:It is incorrect|It is not true) to say\b/i.test(sentence.trim()))
  const crown = crownSelection || sentences.some(sentence => /\b(?:I vote (?:guilty|(?:for )?(?:the )?Crown)|my ballot leans Crown)\b/i.test(sentence))
  const doubt = sentences.some(sentence => /\b(?:retain(?:s|ing)? (?:reasonable )?doubt|(?:with|have|has) remaining doubts?)\b/i.test(sentence) &&
    !/\b(?:not|never|don't|doesn't) retain\b|\b(?:no|not) remaining doubt/i.test(sentence))
  const resolved = resolvedCurrentCrownProof(text)
  return crown && doubt && !resolved
}

export function incompleteCoordinatedOnlySummary(text: string, evidence: EvidenceItem[]): boolean {
  return evidence.some(source => {
    const speaker = source.text.match(/^(?:Fictional (?:witness )?)?([\w-]+) states:/i)?.[1]
    if (!speaker || !/\bI saw\b[^.!?]*standing at the desk\b/i.test(source.text) || !/\bleft with\b/i.test(source.text)) return false
    const only = new RegExp(`\\b${escape(speaker)} gives (?:a|the) different account and(?:,\\s*concerning observation of (?:a|the) handover,)?\\s+records only\\b`, 'i')
    return text.split(/(?<=[.!?])\s+|;\s*/).some(sentence => {
      const match = sentence.match(only)
      if (!match || sentence.trim().endsWith('?') || /\b(?:if|incorrect to say|does not mean)\b/i.test(sentence)) return false
      if (/\bconcerning observation of (?:a|the) handover\b/i.test(match[0])) return false
      const summary = sentence.slice(match.index! + match[0].length)
      return !/\b(?:standing|at the desk|desk presence)\b/i.test(summary) || !/\b(?:left|leaving|departure|departing|departed)\b/i.test(summary)
    })
  })
}

// The generated unclassified/unknown rows describe missing metadata. Explicit
// declarations, including an explicitly declared unknown value, are information.
export function sourceMetadataProvided(evidence: EvidenceItem[], information: string[]): boolean {
  if (evidence.some(source => {
    const row = source as unknown as Record<string, unknown>
    return ['sourceClassification', 'classification', 'verificationStatus'].some(key =>
      typeof row[key] === 'string' && String(row[key]).trim().length > 0)
  })) return true
  return information.some(value =>
    [...value.matchAll(/\b(?:source classification|verification (?:status|state))\s*(?::|is|are|was)\s*([^\n.;"{}]+)/gi)].some(match =>
      !/^(?:not supplied|not provided|unsupplied|unavailable)\b/i.test(match[1].trim())) ||
    evidence.some(source => value.split(/\r?\n/).some(line => {
      const row = line.match(new RegExp(`^${escape(source.exhibitId)}:\\s*([^;]+);\\s*([^;]+);`, 'i'))
      return row && !/^(?:unclassified|admitted|limited|excluded|struck|not admitted)$/i.test(row[1].trim())
    })))
}

export const missingClassificationStatement = /^Both remain disputed accounts, and their source classification and verification status are not supplied\.$/i
