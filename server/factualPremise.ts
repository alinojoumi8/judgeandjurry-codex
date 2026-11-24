import type { GroundingCitation, GroundingFinding } from './grounding'

const normal = (text: string) => text.normalize('NFKC').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim()
const premiseWording = (text: string) => normal(text)
  .replace(/\bno cash (?:(?:has|had|have|was|is|been|ever) )*returned\b/g, 'no cash was returned')
  .replace(/\b(?:did|do|does) not return (?:any )?cash\b/g, 'no cash was returned')
  .replace(/\bno withdrawals of cash that were (?:ever )?(?:actually )?sent back\b/g, 'no cash was returned')
  .replace(/\bno (?:such )?accounts (?:were|had been) opened for any investors(?=[.!?;]|$)/g, 'no investor accounts existed')
const deniedOrConditional = /\b(?:if|whether|unless|not (?:say|state|report|confirm)|never (?:said|stated|reported)|deny|denies|denied|disputes?|disputed|unconfirmed)\b/i

function insideQuotation(text: string, at: number) {
  let curlyDepth = 0, straightOpen = false
  for (const mark of text.slice(0, at).match(/["“”]/g) ?? []) {
    if (mark === '“') curlyDepth++
    else if (mark === '”') curlyDepth = Math.max(0, curlyDepth - 1)
    else straightOpen = !straightOpen
  }
  return straightOpen || curlyDepth > 0
}

// A citation attached to a different coordinated clause cannot establish this
// clause's source contents, even when both locators occur in one finding.
function premiseCitations(prose: string, start: number, end: number, citations: GroundingCitation[]) {
  const groups = /\([^)]*\)|\[[^\]]*\]/g
  const masked = prose.replace(groups, group => ' '.repeat(group.length))
  const boundaries = [...masked.matchAll(/[;.!?]|,\s*(?:and|but|while|yet)\b/g)]
  const left = boundaries.filter(row => row.index! < start).at(-1)
  const right = boundaries.find(row => row.index! >= end)
  const locatorGroup = (group: string) => /\be-\d+\b/.test(group) &&
    !group.replace(/\be-\d+\b|\b(?:paras?|paragraphs?|pp?|pages?|sections?)\b|[\d\s.,;:()[\]–—-]/g, '')
  // A leading locator can qualify a source noun ("the report (E-001)").
  // A prose aside ("compare E-002; unrelated") cannot supply the exhibit.
  const before = prose.slice(left ? left.index! + left[0].length : 0, start).replace(groups, (group, at, line: string) =>
    locatorGroup(group) && /\b(?:reports?|affidavits?|statements?|declarations?|records?|documents?|exhibits?|interviews?|testimony|transcripts?|letters?|emails?|accounts?|sources?)\s*$/.test(line.slice(0, at)) ? group : ' ')
  const after = prose.slice(end, right?.index ?? prose.length).replace(groups, group => locatorGroup(group) ? group : ' ')
  const preceding = [...before.matchAll(/\be-\d+\b/g)].at(-1)?.[0]
  const following = after.match(/\be-\d+\b/g) ?? []
  const allNamed = [...new Set(prose.match(/\be-\d+\b/g) ?? [])]
  const named = preceding ? [preceding] : following.length ? following : allNamed.length === 1 ? allNamed : []
  if (!named.length && allNamed.length > 1) return []
  return citations.filter(citation => !named.length || named.includes(citation.exhibitId.toLowerCase()))
}

// Recognize only an explicitly attributed negative account followed by its
// correction. Identity may use the source introduction; both accounts must
// still occur in order inside ONE selected passage, not elsewhere in the file.
function supportedCorrectionHistory(prose: string, match: RegExpMatchArray, citations: GroundingCitation[], sources: { exhibitId: string; text: string }[]) {
  const prefix = prose.slice(0, match.index).split(/[;.!?:]/).at(-1)?.trim() ?? ''
  const attribution = prefix.match(/^([\p{L} '-]+) corrected (his|her|their) earlier$/u)
  const accounts = match[1].match(/^(.+?) and now (?:says|states|reports)(?: that)? (.+)$/)
  if (!attribution || !accounts) return false
  const wording = (value: string) => premiseWording(value).replace(/acknowledgement/g, 'acknowledgment')
  const datePattern = /\b(?:january|february|march|april|may|june|july|august|september|october|november|december) \d{1,2}(?:,? \d{4})?\b/g
  return citations.some(citation => {
    if (!matchingSourceSpeaker(attribution[1], citation, sources)) return false
    const source = wording(citation.quote)
    const corrections = /\bi (?:incorrectly|mistakenly) (?:stated|said|reported|asserted) that ([^.!?;]+)[.!?]\s*(?:in (?:actual )?fact|actually),?\s*([^.!?;]+)/g
    return [...source.matchAll(corrections)].some(correction => {
      const lead = source.slice(0, correction.index).split(/[.!?;]/).at(-1) ?? ''
      // A quotation or another person's reported words do not become the
      // deponent's own correction merely because the affidavit has a heading.
      if (insideQuotation(source, correction.index!) || deniedOrConditional.test(lead) || /[:"“”]|\b(?:says?|said|reports?|stated)\b/.test(lead)) return false
      const localContext = source.slice(Math.max(0, correction.index! - 250), correction.index)
      const dates = [...wording(accounts[1]).matchAll(datePattern)].map(row => row[0])
      const sourceObject = wording(correction[1]).match(/ did not [a-z]+ the ([\p{L} '-]+)$/u)?.[1]
      const sourceDates = [...localContext.matchAll(datePattern)].filter(row => sourceObject &&
        (localContext.slice(0, row.index).endsWith(sourceObject + ' dated ') ||
          localContext.slice(row.index! + row[0].length).startsWith(' ' + sourceObject))).map(row => row[0])
      if (dates.some(date => { const actual = sourceDates.at(-1); return !actual || !(actual === date || actual.startsWith(date + ', ') || actual.startsWith(date + ' ')) })) return false
      const comparable = (value: string) => {
        let result = wording(value)
        for (const date of dates) result = result.replace('the ' + date + ' ', 'the ')
        return result
      }
      const earlier = comparable(accounts[1])
      if (earlier !== comparable(correction[1])) return false
      const event = earlier.match(/^([\p{L} '-]+) did not ([a-z]+) (the [\p{L} '-]+)$/u)
      if (!event) return false
      const [, subject, verb, object] = event
      const past = verb + (verb.endsWith('e') ? 'd' : 'ed')
      const current = (value: string, reported: boolean) => {
        let result = comparable(value)
        if (reported) result = result.replace('in ' + attribution[2] + ' presence', 'in my presence')
        result = result.replace(subject + ' did ' + verb + ' ', subject + ' ' + past + ' ')
        const pronoun = subject + ' ' + past + ' it'
        return result === pronoun ? subject + ' ' + past + ' ' + object : result.replace(pronoun + ' ', subject + ' ' + past + ' ' + object + ' ')
      }
      const stated = current(accounts[2], true), actual = current(correction[2], false)
      const affirmative = subject + ' ' + past + ' ' + object
      if (actual !== affirmative && !actual.startsWith(affirmative + ' ')) return false
      if (deniedOrConditional.test(actual) || /\b(?:false|untrue|incorrect|unconfirmed|apparently|allegedly)\b/.test(actual)) return false
      return actual === stated || stated.endsWith(' in my presence') &&
        actual === stated + ' and in the presence of various witnesses'
    })
  })
}


// A nested quotation reports the inner speaker's words and the outer author's
// argument separately. Neither part can borrow another document's passages.
function supportedNestedAttribution(prose: string, match: RegExpMatchArray, citations: GroundingCitation[], sources: { exhibitId: string; text: string }[]) {
  const prefix = prose.slice(0, match.index).split(/[;.!?:]/).at(-1)?.trim() ?? ''
  const speakers = prefix.match(/^([\p{L} '-]+) (?:asserts|states|reports) that ([\p{L} '-]+)'s$/u)
  const parts = match[1].match(/^(.+?) ["“]([^"”]+)["”] and argues that (.+)$/)
  if (!speakers || !parts) return false
  const literal = (text: string) => normal(text).replace(/["“”]/g, '')
  const escape = (text: string) => text.replace(/[/\\^$*+?.()|[\]{}]/g, '\\$&')
  return citations.some(citation => {
    if (!matchingSourceSpeaker(speakers[1], citation, sources)) return false
    const selected = citations.filter(other => other.exhibitId === citation.exhibitId)
    const source = normal(citation.quote)
    const sentences = source.split(/(?<=[.!?;])\s+/)
    const endsClause = (sentence: string, claim: string) => {
      const at = sentence.indexOf(claim)
      return at >= 0 && /^\s*[.!?;]?$/.test(sentence.slice(at + claim.length))
    }
    const reported = speakers[2] + "'s " + match[0].slice(0, match[0].indexOf(' that ')) + ' that ' + literal(parts[1]) + ' ' + literal(parts[2])
    let offset = 0
    const ownReport = sentences.some(sentence => {
      const start = source.indexOf(sentence, offset)
      offset = start + sentence.length
      const at = sentence.indexOf(speakers[2] + "'s ")
      if (at < 0 || insideQuotation(source, start + at)) return false
      const lead = sentence.slice(0, at).trim()
      // A discourse marker or the deponent's own reporting verb can introduce
      // the inner speaker. A second reporter cannot speak for the deponent.
      if (!/^(?:(?:first(?:ly)?|second(?:ly)?|third(?:ly)?|further(?:more)?|also|however|finally),? *)?(?:i (?:assert|state|report|note|say|submit) that *)?$/.test(lead)) return false
      return endsClause(literal(sentence.slice(at)), reported) && !deniedOrConditional.test(sentence) &&
        !/\b(?:false|untrue|incorrect|hypothetical)\b/.test(sentence)
    })
    if (!ownReport) return false
    const rationale = literal(parts[3])
    const unconditional = (sentence: string) => !deniedOrConditional.test(sentence) &&
      !/[:"“”]|\b(?:false|untrue|incorrect|unconfirmed)\b/.test(sentence)
    const assertions = (quote: string) => {
      const text = normal(quote)
      let offset = 0
      return text.split(/(?<=[.!?;])\s+/).filter(sentence => {
        const start = text.indexOf(sentence, offset)
        offset = start + sentence.length
        return !insideQuotation(text, start) && unconditional(sentence)
      })
    }
    if (selected.some(other => assertions(other.quote).some(sentence => {
      const argument = literal(sentence)
      return argument.startsWith('i argue that ') && endsClause(argument, 'i argue that ' + rationale)
    }))) return true
    // Bounded negative-property rationale: the author's selected account must
    // explicitly state both the causal lack of assets and the jurisdictional
    // property statement. A connection, another speaker or a different province
    // cannot supply that causal argument.
    const property = rationale.match(/^the ([\p{L} -]+) is ([a-z]+) because (he|she|[\p{L} '-]+) (?:owns|has) no ([\p{L} -]+) property$/u)
    if (!property || !['he', 'she', speakers[1]].includes(property[3])) return false
    const [, subject, predicate, , jurisdiction] = property
    const causal = new RegExp('\\bsince i do not have any such assets, continuing with the (?:[\\p{L}-]+ )?' + escape(subject) + ' is ' + escape(predicate) + '\\b', 'u')
    const assetLocation = new RegExp('\\b(?:assets?|property)\\b[^.!?;,]{0,140}?\\b(?:in|within) (?:the )?(?:(?:province|territory|state) of )?' + escape(jurisdiction) + '(?=[.;,]|$)', 'u')
    const ownAssertions = new Set(assertions(citation.quote))
    const causalAccount = sentences.some((sentence, index) => index > 0 && ownAssertions.has(sentence) &&
      causal.test(sentence) && ownAssertions.has(sentences[index - 1]) && assetLocation.test(sentences[index - 1]))
    const ownership = new RegExp('\\bi do not own any property in ' + escape(jurisdiction) + '(?=$|[.;]|, and i\\b)')
    return causalAccount &&
      selected.some(other => assertions(other.quote).some(sentence => ownership.test(sentence)))
  })
}

function matchingSourceSpeaker(speaker: string, citation: GroundingCitation, sources: { exhibitId: string; text: string }[]) {
  const source = sources.find(item => item.exhibitId === citation.exhibitId)
  if (!source) return undefined
  const opening = normal(source.text.slice(0, Math.min(citation.endOffset, 3000)))
  const before = normal(source.text.slice(0, Math.min(citation.startOffset, 3000)))
  const oaths = [...opening.matchAll(/\bi,\s*([\p{L} '-]+),.{0,600}?\bmake oath and say:/gu)]
    .filter(row => !insideQuotation(opening, row.index!))
  // An oath included by the first locator must introduce the passage itself.
  // Ignore an embedded or later oath as a substitute for an unknown author.
  if (oaths.length > 1 || oaths.some(row => row.index! >= before.length &&
    !/^(?:affidavit of [\p{L} '-]+)?$/u.test(opening.slice(0, row.index).trim()))) return undefined
  const identities = oaths.map(row => row[1].trim())
  const named = opening.match(/^(?:fictional )?([\p{L} '-]+) (?:states|says|reports):/u)?.[1]
  if (named) identities.push(named)
  if (identities.length === 1 && [identities[0], identities[0].split(' ').at(-1)].includes(speaker)) return identities[0]
}

// A change in one person's account requires that person's own selected history.
// Conflicting speakers do not supply a revision merely by disagreeing.
function changedAccountError(prose: string, citations: GroundingCitation[], sources: { exhibitId: string; text: string }[]) {
  const changes = /\b([\p{L} '-]+?)'s (?:account|position|story|evidence)(?: (?:of|on|about) ([\p{L} '-]+?))? (?:has |had )?(?:(?:materially|substantially|significantly) )?(?:changed|shifted|reversed)\b/gu
  // Remove source context before comparing the complete possessive name against the cited speaker.
  const sourceLocation = /\b(?:in|from|according to) (?:(?:the|an?|this|that|these|those|his|her|their) )?(?:(?:first|second|third|fourth|last|earlier|later|original|amended|supplemental|supplementary|cited|selected) )*(?:affidavits?|statements?|declarations?|testimony|transcripts?|reports?|exhibits?|passages?) /
  const reportingPhrase = /^(?:(?:the|this|these|those) )?(?:(?:cited|selected) )?(?:records?|evidence|passages?|sources?|exhibits?) (?:shows?|showed|indicates?|indicated|confirms?|confirmed|demonstrates?|demonstrated) /
  for (const match of prose.matchAll(changes)) {
    const context = (prose.slice(0, match.index).split(/[;.!?]/).at(-1) ?? '') + match[1]
    const clause = context.split(/\b(?:but|yet|whereas)\b|,\s*(?:and|while)\b/).at(-1)!.trim()
    const unestablished = /\b(?:does not|do not|did not|doesn't|don't|didn't) (?:show|establish|demonstrate|indicate|confirm|prove) (?:that )?[\p{L} '-]+$/u
    if (deniedOrConditional.test(clause) || unestablished.test(clause) || /\b(?:false|untrue)\b/.test(clause)) continue
    const subject = match[1].replace(sourceLocation, '')
    const speaker = subject.split(/\b(?:that|because|although|while)\b/).at(-1)!.trim().replace(reportingPhrase, '')
    const topics = normal(match[2] ?? '').replace(/acknowledgement/g, 'acknowledgment').split(' ').filter(word => word && !['the', 'a', 'an'].includes(word))
    if (!topics.length) return `Name what changed in ${speaker}'s account and cite that speaker's selected statements about it.`
    const selected = premiseCitations(prose, match.index!, match.index! + match[0].length, citations)
    const accounts = selected.flatMap(citation => {
      const identity = matchingSourceSpeaker(speaker, citation, sources)
      if (!identity) return []
      const source = normal(citation.quote).replace(/acknowledgement/g, 'acknowledgment')
      let offset = 0
      const sentences = source.split(/(?<=[.!?;])\s+/).filter(sentence => {
        const start = source.indexOf(sentence, offset)
        offset = start + sentence.length
        return !insideQuotation(source, start) && !/["“”]/.test(sentence) && !deniedOrConditional.test(sentence) &&
          !/\b(?:false|untrue|hypothetical)\b/.test(sentence)
      })
      const own = sentences.filter(sentence => /\bi [a-z]+ /.test(sentence) && topics.every(topic => sentence.includes(topic)))
      const correctedAt = sentences.findIndex(sentence => own.includes(sentence) && /\bi (?:incorrectly|mistakenly) (?:stated|said|reported|asserted) that\b/.test(sentence))
      const correction = correctedAt >= 0 && sentences.slice(correctedAt + 1).some(sentence => /^(?:in (?:actual )?fact|actually),?\s+/.test(sentence) && topics.every(topic => sentence.includes(topic)))
      return [{ identity, exhibitId: citation.exhibitId, own, correction }]
    })
    const claims = accounts.flatMap(account => account.own.flatMap(sentence => {
      const assertion = sentence.match(/\bi (?:(did not|didn't|did|do not|don't|never) )?([a-z]+) ([^.!?;]+)[.!?;]?$/)
      if (!assertion) return []
      const [, auxiliary, verb, object] = assertion
      const verbs = new Set([verb, ...(verb.endsWith('ed') ? [verb.slice(0, -2), verb.slice(0, -1)] : [])])
      return [{ identity: account.identity, exhibitId: account.exhibitId, negative: /not|n't|never/.test(auxiliary ?? ''), verbs, object: object.trim() }]
    }))
    const opposed = claims.some(earlier => claims.some(later => earlier.identity === later.identity && earlier.exhibitId !== later.exhibitId &&
      earlier.negative !== later.negative && earlier.object === later.object && [...earlier.verbs].some(verb => later.verbs.has(verb))))
    if (new Set(accounts.map(account => account.identity)).size !== 1 || !accounts.some(account => account.correction) && !opposed) {
      return `The reported change in ${speaker}'s own account needs that speaker's selected earlier and later statements or an explicit correction by that speaker. A conflicting account or correction by another speaker does not establish this history.`
    }
  }
}

// These constructions assert a source's contents even when the remainder only
// discusses their significance. Bind the reported clause to selected passages,
// never a nearby quotation from another document or an uncited paragraph.
export function factualPremiseError(text: string, citations: GroundingCitation[], records: NonNullable<GroundingFinding['recordCitations']> = [], sources: { exhibitId: string; text: string }[] = []): string | undefined {
  const prose = normal(text)
  const historyError = changedAccountError(prose, citations, sources)
  if (historyError) return historyError
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
    if (supportedCorrectionHistory(prose, match, selected, sources) || supportedNestedAttribution(prose, match, selected, sources)) continue
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
      const reportedOwner = sentence.match(new RegExp(`\\b([\\p{L}]+)'s (?:statement|report|assertion|confirmation) that ["“]?${pattern}`, 'u'))?.[1]
      if (owner && reportedOwner && owner !== reportedOwner) return false
      return new RegExp(`(?:^|[\\s:"“])${pattern}(?=$|[\\s,.;:!?"”')])`).test(comparable) &&
        !deniedOrConditional.test(sentence) && !/\b(?:incorrectly|mistakenly) (?:stated|said|reported|asserted) that\b/.test(sentence) && !/\b(?:is|was|were) (?:false|untrue|incorrect|not accurate)\b/.test(sentence)
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
