// Plan section 4, rule 12: advice stays lawful and honest. Strategy output must
// never propose inventing evidence, altering or destroying a record, false
// testimony, coaching a witness to say anything but the truth, or concealing
// evidence. These are deterministic pattern checks on text. They are a floor,
// not a guarantee: a model can phrase an improper idea in words no pattern
// anticipates, so a lawyer still reads every proposal. They are tested with
// hostile samples and with valid controls (honest witness preparation passes).

export const improperCodes = ['fabricate_evidence', 'alter_or_destroy_record', 'false_testimony', 'coach_witness', 'conceal_or_obstruct'] as const
export type ImproperCode = (typeof improperCodes)[number]

export const improperLabels: Record<ImproperCode, string> = {
  fabricate_evidence: 'inventing or falsifying evidence',
  alter_or_destroy_record: 'altering or destroying a record',
  false_testimony: 'false testimony',
  coach_witness: 'coaching a witness to say something other than the truth',
  conceal_or_obstruct: 'concealing evidence or obstructing a witness',
}

export interface ImproperMatch {
  code: ImproperCode
  excerpt: string
}

const noun = String.raw`(?:evidence|documents?|records?|e-?mails?|receipts?|invoices?|logs?|entr(?:y|ies)|notes?|photos?|photographs?|videos?|footage|reports?|statements?|affidavits?|exhibits?|signatures?|messages?|texts?|charts?|metadata|timestamps?|letters?|contracts?|agreements?|recordings?|files?|data|exports?|testimony|transcripts?)`
// Up to five words between a verb and the thing it acts on.
const gap = String.raw`(?:\W+\w+){0,5}?\W+`

// Words in the same sentence that show a change to a record is meant to deceive.
const deception = new RegExp(String.raw`\b(?:quiet(?:ly)?|secret(?:ly)?|discreet(?:ly)?|without\s+(?:telling|disclos\w*|noting|mentioning|anyone|saying)|after\s+the\s+fact|retroactiv\w*|backdat\w*|so\s+(?:that\s+)?(?:it|they|the\s+\w+)\s+(?:look|appear|seem|read|say|show|match)\w*|to\s+(?:make|have)\s+(?:it|them)\s+(?:look|appear|seem|read|say|show|match)\w*|to\s+(?:match|fit)\b|to\s+(?:hide|conceal|cover)\b|before\s+(?:production|disclosure|discovery|it\s+is\s+produced|anyone))`, 'i')

interface Rule {
  code: ImproperCode
  regex: RegExp
  // The sentence must also match this (a soft verb counts only with a deceptive purpose).
  cue?: RegExp
  // A sentence matching this is not refused (a privilege claim is not concealment).
  unless?: RegExp
  // A match followed by this is honest ("what to say if she does not remember").
  honestAfter?: RegExp
}

const rules: Rule[] = [
  // Inventing or falsifying evidence.
  { code: 'fabricate_evidence', regex: new RegExp(String.raw`\b(?:fabricat(?:e|es|ing)|forg(?:e|es|ing)|falsif(?:y|ies|ying)|counterfeit(?:s|ing)?|backdat(?:e|es|ing)|post-?dat(?:e|es|ing)|doctor(?:ing)|manufactur(?:e|es|ing)|concoct(?:s|ing)?|invent(?:s|ing)?|mak(?:e|es|ing)\s+up|conjur(?:e|es|ing)\s+up)\b${gap}(?:${noun}|witness(?:es)?)\b`, 'gi') },
  { code: 'fabricate_evidence', regex: new RegExp(String.raw`\b(?:creat(?:e|es|ing)|produc(?:e|es|ing)|submit(?:s|ting)?|fil(?:e|es|ing)|us(?:e|es|ing)|provid(?:e|es|ing)|present(?:s|ing)?|offer(?:s|ing)?|prepar(?:e|es|ing)|draft(?:s|ing)?|generat(?:e|es|ing)|writ(?:e|es|ing)|suppl(?:y|ies|ying))\b${gap}(?:false|fake|fictitious|phony|bogus|backdated|forged|sham|retroactive|after-the-fact)\s+(?:\w+\s+){0,2}?${noun}\b`, 'gi') },
  { code: 'fabricate_evidence', regex: /\bplant(?:s|ing)?\s+(?:(?:false|fake|misleading)\s+)?evidence\b/gi },
  // Altering or destroying a record.
  { code: 'alter_or_destroy_record', regex: new RegExp(String.raw`\b(?:destroy(?:s|ing)?|delet(?:e|es|ing)|shred(?:s|ding)?|wip(?:e|es|ing)|eras(?:e|es|ing)|overwrit(?:e|es|ing)|scrub(?:s|bing)?|purg(?:e|es|ing)|get(?:ting)?\s+rid\s+of|dispos(?:e|es|ing)\s+of)\b${gap}${noun}\b`, 'gi') },
  { code: 'alter_or_destroy_record', regex: new RegExp(String.raw`\b(?:alter(?:s|ing)?|tamper(?:s|ing)?\s+with)\b${gap}${noun}\b`, 'gi') },
  { code: 'alter_or_destroy_record', regex: new RegExp(String.raw`\b(?:edit(?:s|ing)?|chang(?:e|es|ing)|modif(?:y|ies|ying)|rewrit(?:e|es|ing)|revis(?:e|es|ing)|adjust(?:s|ing)?|touch(?:es|ing)?\s+up|massag(?:e|es|ing)|clean(?:s|ing)?\s+up|updat(?:e|es|ing))\b${gap}${noun}\b`, 'gi'), cue: deception },
  // False testimony.
  { code: 'false_testimony', regex: /\b(?:perjur\w*|suborn\w*)\b/gi },
  { code: 'false_testimony', regex: new RegExp(String.raw`\b(?:testif(?:y|ies|ying)|swear(?:s|ing)?|depos(?:e|es|ing)|stat(?:e|es|ing)|say(?:s|ing)?|claim(?:s|ing)?|assert(?:s|ing)?)\b${gap}(?:falsely|untruthfully|dishonestly)\b`, 'gi') },
  { code: 'false_testimony', regex: /\b(?:falsely|untruthfully|dishonestly)\s+(?:testif\w+|swear\w*|say|state|claim|assert\w*)\b/gi },
  { code: 'false_testimony', regex: new RegExp(String.raw`\b(?:giv(?:e|es|ing)|provid(?:e|es|ing)|offer(?:s|ing)?|prepar(?:e|es|ing)|draft(?:s|ing)?|submit(?:s|ting)?|present(?:s|ing)?|elicit(?:s|ing)?|get(?:s|ting)?|hav(?:e|es|ing)|encourag(?:e|es|ing)|help(?:s|ing)?|let(?:s|ting)?|allow(?:s|ing)?|produc(?:e|es|ing)|us(?:e|es|ing))\b${gap}(?:false|untrue|untruthful|fabricated|perjured|misleading)\s+(?:testimony|evidence|answers?|accounts?|stor(?:y|ies)|statements?|affidavits?)\b`, 'gi') },
  { code: 'false_testimony', regex: new RegExp(String.raw`\b(?:lie|lies|lying)\b${gap}(?:under\s+oath|on\s+oath|on\s+the\s+stand|in\s+court|to\s+the\s+(?:court|jury|judge)|at\s+trial|at\s+discovery|in\s+(?:an?\s+)?affidavit)\b`, 'gi') },
  // Coaching a witness to say something other than the truth.
  { code: 'coach_witness', regex: /\bwhat\s+(?:to|(?:they|she|he|the\s+witness)\s+(?:should|must|needs\s+to))\s+(?:say|testify|answer|claim|state)\b/gi, honestAfter: /^.{0,90}?(?:\btruth\w*|\bhonest\w*|\bif\s+(?:she|he|they|the\s+witness)\s+(?:does\s*n[o']t|do\s*n[o']t|cannot|can't|is\s+not|are\s+not)\s+(?:remember|recall|know|understand|sure))/i },
  { code: 'coach_witness', regex: new RegExp(String.raw`\b(?:coach(?:es|ing)?|script(?:s|ed|ing)?|memori[sz](?:e|es|ing))\b${gap}(?:answers?|testimony|accounts?|stor(?:y|ies)|lines|responses?|replies)\b`, 'gi') },
  { code: 'coach_witness', regex: /\bwitness(?:es)?\b(?:\W+\w+){0,5}?\W+to\s+(?:change\s+(?:her|his|their|the|an?)\s+(?:story|account|answers?|testimony|evidence)|omit\b|forget\b|leave\s+out|conform|align\s+(?:her|his|their)|match\s+(?:the|her|his|their|what)|adopt\s+(?:the|a|this|that|her|his|their)\s+(?:version|account|story)|agree\s+that)/gi },
  { code: 'coach_witness', regex: /\bwitness\b[^.]{0,80}?\bto\s+(?:say|testify|claim|state|swear|assert|recall|remember)\b[^.]*?\b(?:even\s+if|whether\s+or\s+not|regardless)\b/gi },
  { code: 'coach_witness', regex: new RegExp(String.raw`\b(?:help(?:s|ing)?|get(?:s|ting)?|encourag(?:e|es|ing)|persuad(?:e|es|ing)|convinc(?:e|es|ing)|mak(?:e|es|ing)|hav(?:e|es|ing))\b(?:\W+\w+){0,3}?\W+witness(?:es)?\b(?:\W+\w+){0,3}?\W+(?:to\s+)?(?:recall|remember|recollect)\s+that\b`, 'gi') },
  // Concealing evidence, bribing or intimidating.
  { code: 'conceal_or_obstruct', regex: new RegExp(String.raw`\b(?:conceal(?:s|ing)?|hid(?:e|es|ing)|bur(?:y|ies|ying))\b${gap}${noun}\b`, 'gi') },
  { code: 'conceal_or_obstruct', regex: new RegExp(String.raw`\bwithhold(?:s|ing)?\b${gap}${noun}\b(?:\W+\w+){0,6}?\W+from\s+(?:the\s+)?(?:other\s+side|opposing|defen\w+|plaintiff|court|jury|judge|disclosure|production|counsel)`, 'gi'), unless: /\bprivileg\w*/i },
  { code: 'conceal_or_obstruct', regex: /\b(?:bribe|bribing|bribery|intimidat(?:e|es|ing)|blackmail(?:s|ing)?|threaten(?:s|ing)?\s+(?:the\s+)?witness)\b/gi },
  { code: 'conceal_or_obstruct', regex: new RegExp(String.raw`\b(?:fail(?:s|ing)?\s+to|refus(?:e|es|ing)\s+to|avoid(?:s|ing)?|omit(?:s|ting)?)\s+(?:disclos|produc)\w*\s+(?:\w+\s+){0,3}?(?:damaging|harmful|adverse|unfavou?rable|bad|responsive|relevant)\s+(?:\w+\s+){0,2}?${noun}\b`, 'gi') },
]

const negations = new Set([
  'not', 'never', 'no', 'without', 'avoid', 'avoiding', "don't", 'dont', "doesn't", "can't", 'cannot', "won't", "shouldn't", "mustn't", 'refrain',
  'prevent', 'preventing', 'prohibit', 'prohibited', 'forbid', 'forbidden', 'illegal', 'unlawful', 'improper', 'unethical', 'stop', 'against', 'nobody',
])
const contrasts = new Set(['but', 'however', 'instead', 'rather', 'just', 'then', 'except', 'although', 'though', 'yet', 'still'])

// True when a negation reaches the match: one of the last twelve words before it
// is a negation and no contrasting word comes after that negation.
function negated(sentence: string, index: number): boolean {
  const words = sentence.slice(0, index).toLowerCase().split(/[^a-z']+/).filter(Boolean).slice(-12)
  for (let position = words.length - 1; position >= 0; position -= 1) {
    if (contrasts.has(words[position])) return false
    if (negations.has(words[position])) return true
  }
  return false
}

const clip = (text: string, max = 140) => (text.length > max ? `${text.slice(0, max)}…` : text)

// Every improper proposal the text contains. Empty text and honest text return [].
export function scanImproper(text: string): ImproperMatch[] {
  if (typeof text !== 'string' || !text.trim()) return []
  const found: ImproperMatch[] = []
  const seen = new Set<string>()
  for (const sentence of text.split(/[.!?;\n]+/).map((part) => part.trim()).filter(Boolean)) {
    for (const rule of rules) {
      if (rule.cue && !rule.cue.test(sentence)) continue
      if (rule.unless?.test(sentence)) continue
      for (const match of sentence.matchAll(rule.regex)) {
        const start = match.index ?? 0
        if (negated(sentence, start)) continue
        if (rule.honestAfter?.test(sentence.slice(start + match[0].length))) continue
        const key = `${rule.code}|${match[0].toLowerCase()}`
        if (seen.has(key)) continue
        seen.add(key)
        found.push({ code: rule.code, excerpt: clip(match[0]) })
      }
    }
  }
  return found
}

export interface FieldMatch extends ImproperMatch {
  field: string
}

export function scanImproperFields(fields: Record<string, string | undefined>): FieldMatch[] {
  return Object.entries(fields).flatMap(([field, value]) => scanImproper(value ?? '').map((match) => ({ ...match, field })))
}

export function improperReason(matches: ReadonlyArray<Pick<ImproperMatch, 'code'>>): string {
  const labels = [...new Set(matches.map((match) => improperLabels[match.code]))]
  return `Refused: it proposes ${labels.join('; ')}. TrialLens never proposes inventing or falsifying evidence, altering or destroying a record, false testimony, coaching a witness to say anything but the truth, or concealing evidence. Honest preparation only.`
}

// Witness preparation is framed as truthful preparation: it says the witness
// tells the truth or speaks from their own memory.
export function framedAsTruthful(text: string): boolean {
  return /\b(?:truth\w*|honest\w*|own\s+(?:memory|recollection|words|knowledge)|what\s+(?:she|he|they|the\s+witness)\s+(?:actually\s+)?(?:saw|remember\w*|knows?|knew|heard))\b/i.test(text)
}
