import type { GroundingCitation, GroundingFinding } from './grounding'

const normal = (text: string) => text.normalize('NFKC').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim()
const premiseWording = (text: string) => normal(text)
  .replace(/\bno cash (?:(?:has|had|have|was|is|been|ever) )*returned\b/g, 'no cash was returned')
  .replace(/\b(?:did|do|does) not return (?:any )?cash\b/g, 'no cash was returned')
  .replace(/\bno withdrawals of cash that were (?:ever )?(?:actually )?sent back\b/g, 'no cash was returned')
  .replace(/\bno (?:such )?accounts (?:were|had been) opened for any investors(?=[.!?;]|$)/g, 'no investor accounts existed')
const deniedOrConditional = /\b(?:if|whether|unless|not (?:say|state|report|confirm)|never (?:said|stated|reported)|deny|denies|denied|disputes?|disputed|unconfirmed)\b/i

// A citation attached to a different coordinated clause cannot establish this
// clause's source contents, even when both locators occur in one finding.
function premiseCitations(prose: string, start: number, end: number, citations: GroundingCitation[]) {
  const clauseBoundary = /[;.!?]|,\s*(?:and|but|while|yet)\b/
  const before = prose.slice(0, start).split(clauseBoundary).at(-1) ?? ''
  const after = prose.slice(end).split(clauseBoundary)[0]
  const preceding = [...before.matchAll(/\be-\d+\b/g)].at(-1)?.[0]
  const following = after.match(/\be-\d+\b/g) ?? []
  const allNamed = [...new Set(prose.match(/\be-\d+\b/g) ?? [])]
  const named = preceding ? [preceding] : following.length ? following : allNamed.length === 1 ? allNamed : []
  return citations.filter(citation => !named.length || named.includes(citation.exhibitId.toLowerCase()))
}

// These constructions assert a source's contents even when the remainder only
// discusses their significance. Bind the reported clause to selected passages,
// never a nearby quotation from another document or an uncited paragraph.
export function factualPremiseError(text: string, citations: GroundingCitation[], records: NonNullable<GroundingFinding['recordCitations']> = []): string | undefined {
  const prose = normal(text)
  // Reporting reliance adds a causal premise beyond the existence of a named
  // connection. It must be present in this clause's selected source, not a
  // different document quoted elsewhere in the finding.
  for (const match of prose.matchAll(/\b(?:his|her|their|[\p{L}-]+'s) reliance on (?:the )?(.+?)(?=\s*\(e-\d|,|;|[.!?]| and | but |$)/gu)) {
    const prefix = prose.slice(0, match.index).split(/[;.!?]/).at(-1) ?? ''
    if (/\b(?:if|whether|does not establish|doesn't establish|not evidence of|no proof of|no evidence of)\b/.test(prefix)) continue
    const selected = premiseCitations(prose, match.index!, match.index! + match[0].length, citations)
    const terms = match[1].match(/[\p{L}]+/gu)?.filter(word => !['the', 'a', 'an', 'connection', 'affiliation', 'association', 'relationship'].includes(word)) ?? []
    const owner = prefix.match(/\b([\p{L}-]+)'s (?:recorded )?account\b/u)?.[1]
    const supported = selected.some(citation => {
      const source = normal(citation.quote)
      const speaker = source.match(/\bquotes ([\p{L}-]+):/u)?.[1] ?? source.match(/^(?:fictional )?([\p{L}-]+) (?:states|says|reports):/u)?.[1]
      if (owner && speaker && owner !== speaker) return false
      return source.split(/(?<=[.!?])\s+/).some(sentence => terms.every(term => sentence.includes(term)) &&
        !/\b(?:never|not|didn't|did not) (?:relied?|reliance|depend)/.test(sentence) &&
        (/\b(?:relied|reliance|depended)\b/.test(sentence) ||
          /\b(?:important|mattered)\b[^.!?]{0,200}\b(?:would not|without|but for)\b/.test(sentence) ||
          /\b(?:without|but for|were it not for)\b[^.!?]{0,160}\b(?:would not|invest\w*|provid\w*|funds)\b/.test(sentence)))
    })
    if (!supported) return `The reported reliance premise "${match[0]}" is not established by its selected source passage. A connection alone does not establish reliance. Preserve the actual document, speaker and disputed status, or remove this unsupported attribution.`
  }
  const nominal = /\b(?:statement|report|assertion|confirmation) that (.+?)(?= (?:also )?(?:supports?|informs?|leaves?|does not|cannot|suggests?|requires? (?:independent |further )?proof|(?:remains?|is|was) (?:still )?(?:an? |the )?(?:allegation|assertion requiring|unproven|unverified))\b|\s*\(e-\d+\b|, (?:but|while|yet)\b|[;.!?]|$)/g
  const direct = /\b(?:reports?|states?|confirms?) that (no cash (?:(?:has|had|have|was|is|been|ever) )*returned\b[^;.!?]*?)(?=, (?:but|while|yet)\b|[;.!?]|$)/g
  const premises = [...prose.matchAll(nominal), ...prose.matchAll(direct)]
    .filter(match => {
      const clause = prose.slice(0, match.index).split(/[;.!?]/).at(-1)!.trim()
      const sourceAbsence = /\b(?:does|do|did) not (?:include|contain|record|mention|state|report|confirm)\b/.test(clause) || /\bis not in (?:the |that |this )?(?:(?:supplied|selected|provided) )?(?:report|interview|affidavit|document)(?: excerpts?| extracts?| pages?| passages?)?$/.test(match[1].trim())
      return !sourceAbsence && !/^(?:if|whether|does|did|can|could)\b/.test(clause) && !deniedOrConditional.test(clause)
    })
  for (const match of premises) {
    const peer = prose.slice(0, match.index).match(/\bjuror[- ]?0?(\d+)'s\s*$/)?.[1]
    const quoted = prose.slice(match.index! + match[0].indexOf(match[1])).match(/^["“]([^"”]+)["”]/)?.[1]
    // A verified peer's quoted doubt is an opinion about the record, not a
    // nominal assertion about a document's contents. Only this bounded clause
    // is exempt; factual premises elsewhere still need their source passages.
    if (peer && quoted && /^(?:the |this )?(?:report|account|statement|record|e-\d+) (?:does not|doesn't|cannot|can't) (?:resolve|settle|remove|answer) (?:my|our) (?:reasonable )?doubts?(?: about [\p{L}\d '-]+)?[.!?]?$/u.test(quoted) &&
      records.some(record => Number(record.actorId?.match(/^juror[- ]?0?(\d+)$/i)?.[1]) === Number(peer) && normal(record.quote).includes(quoted))) continue
    const selected = premiseCitations(prose, match.index!, match.index! + match[0].length, citations)
    // Sentence boundaries may cut a quoted premise before its closing mark.
    // Quote delimiters are not spoken words; the separate quotation validator
    // still checks the complete quotation and its document attribution.
    const premise = premiseWording(match[1].replace(/\s*\([Ee]-\d+[^)]*\)\s*$/, '').replace(/^["“]|["”]$/g, '')).trim()
    const owner = prose.slice(0, match.index).match(/\b([\p{L}]+)'s\s*$/u)?.[1]
    // A less specific noun phrase can omit a colour; it cannot change one.
    const pattern = premise.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\bthe (?=\w+\b)/g, 'the (?:red |orange |yellow |green |blue |purple |black |white |grey |gray |brown )?')
    const supported = selected.some(citation => premiseWording(citation.quote).split(/(?<=[.!?;])\s+/).some(sentence => {
      // Resolve indirect "they" only when the same named speaker introduces
      // the selected account in the source. Do not transfer a peer's words.
      const sameSpeaker = owner && new RegExp(`^${owner} (?:states?|says?|reports?):`).test(premiseWording(citation.quote))
      const comparable = sameSpeaker && /^they\b/.test(premise) ? sentence.replace(/\bi\b/g, 'they') : sentence
      return new RegExp(`(?:^|[\\s:"“])${pattern}(?=$|[\\s,.;:!?"”')])`).test(comparable) &&
        !deniedOrConditional.test(sentence) && !/\b(?:is|was|were) (?:false|untrue|incorrect|not accurate)\b/.test(sentence)
    }))
    if (!supported) return `The reported factual premise "${match[1].trim()}" is not established by the selected passage of its cited source. Analytical significance does not supply source contents. Quote the actual statement, preserve its qualifications, or remove the unsupported premise.`
  }
  // A platform connection is not evidence that the connection caused an
  // investment. Require that reliance relationship in the selected source,
  // preserving its subject and polarity rather than borrowing a nearby topic.
  const influence = /\b([\p{L}-]+)'s (affiliation|association|reputation|relationship) (?:materially |significantly )?(?:influenced|affected|determined) (?:the |my |their |his |her )?investment decision\b/gu
  for (const match of prose.matchAll(influence)) {
    if (deniedOrConditional.test(prose.slice(0, match.index).split(/[;.!?]/).at(-1) ?? '')) continue
    const selected = premiseCitations(prose, match.index!, match.index! + match[0].length, citations)
    const subject = `${match[1]}'s ${match[2]}`
    const supported = selected.some(citation => normal(citation.quote).split(/(?<=[.!?;])\s+/).some(sentence => {
      const clause = sentence.slice(sentence.indexOf(subject))
      return sentence.includes(subject) && !deniedOrConditional.test(sentence) && !/\b(?:is|was|were) (?:false|untrue|incorrect|not accurate)\b/.test(sentence) && !/\b(?:not|never)\b/.test(clause.replace(/would not have invested (?:otherwise|but for)/g, 'relied')) &&
        (/\b(?:materially |significantly )?(?:influenced|affected|determined) (?:the |my |their |his |her )?investment decision\b/.test(clause) || /\b(?:so |very )?important\b.*\bwould not have invested (?:otherwise|but for)\b/.test(clause))
    }))
    if (!supported) return `The investment-influence premise "${match[0]}" is not established by its selected source passage. A connection or affiliation alone does not establish reliance. Preserve the actual document, speaker and disputed status, or remove this unsupported attribution.`
  }
}
