// Readability and jargon density, computed in code (plan F7). These are STATED
// HEURISTICS: the Flesch formulas are standard, but the syllable counter is a
// rule of thumb, the jargon list is a short curated list of medical, economic
// and legal terms, and the bands and thresholds below are this project's own
// choices. They estimate how hard a text is for a lay reader. They do not
// measure what a real juror understood.

export const readabilityHeuristicNote =
  'Stated heuristic: Flesch reading ease and Flesch-Kincaid grade from a rule-of-thumb syllable count, plus the share of words that belong to a short list of medical, economic and legal terms. It estimates difficulty for a lay reader and is not a measurement of what any juror understood.'

export const readabilityThresholds = {
  // Above this grade level a text is treated as hard for a lay reader.
  hardGrade: 12,
  // Above this share of jargon words a text is treated as jargon-heavy.
  heavyJargonShare: 0.05,
} as const

// Curated terms. Lower case; matched on word boundaries; multi-word terms match as a phrase.
export const jargonTerms: readonly string[] = [
  'arthroplasty', 'tibial', 'plateau', 'fixation', 'effusion', 'degenerative', 'compartment', 'quadriceps', 'medial', 'lateral',
  'osteoarthritis', 'arthroscopy', 'orthopaedic', 'orthopedic', 'radiograph', 'sequelae', 'prognosis', 'etiology', 'pathology',
  'comorbidity', 'idiopathic', 'ambulation', 'range of motion', 'weight bearing', 'open reduction', 'internal fixation', 'musculoskeletal',
  'present value', 'discount rate', 'actuarial', 'annuity', 'nominal', 'mortality', 'multiplier', 'capitalization', 'labour force market',
  'work life expectancy', 'residual earning capacity', 'balance of probabilities', 'causation', 'apportionment', 'methodology',
  'confidence interval', 'regression', 'pursuant', 'aforementioned', 'inter alia', 'prima facie', 'differential diagnosis', 'standard of care',
]

const abbreviations = /\b(Dr|Mr|Mrs|Ms|Prof|Inc|Ltd|Co|Corp|vs|No|St|Jr|Sr|approx|etc|[ap]\.m|[A-Z])\./g

export function countSyllables(word: string): number {
  const cleaned = word.toLowerCase().replace(/[^a-z]/g, '')
  if (!cleaned) return 0
  if (cleaned.length <= 3) return 1
  const stripped = cleaned.replace(/(?:[^laeiouy]es|[^laeiouy]ed|[^laeiouy]e)$/, '').replace(/^y/, '')
  const groups = stripped.match(/[aeiouy]{1,2}/g)
  return Math.max(1, groups ? groups.length : 1)
}

function sentencesOf(text: string): string[] {
  // A private-use character stands in for the dot of an abbreviation while sentences are split.
  const protectedText = text.replace(abbreviations, (match) => match.replaceAll('.', ''))
  const lines = protectedText.split(/\n+/).map((line) => line.trim()).filter(Boolean)
  const sentences: string[] = []
  for (const line of lines) {
    const parts = line.split(/(?<=[.!?])\s+(?=[A-Z0-9"'(])/).map((part) => part.replace(//g, '.').trim()).filter(Boolean)
    for (const part of parts) {
      // A short line with no closing punctuation is a heading, not a sentence.
      const words = part.match(/[A-Za-z][A-Za-z'’-]*/g)?.length ?? 0
      if (words <= 3 && !/[.!?]$/.test(part)) continue
      sentences.push(part)
    }
  }
  return sentences
}

export interface ReadabilityResult {
  words: number
  sentences: number
  syllables: number
  averageSentenceLength: number
  averageSyllablesPerWord: number
  fleschReadingEase: number
  fleschKincaidGrade: number
  jargon: { terms: Array<{ term: string; count: number }>; words: number; share: number }
  band: 'plain' | 'moderate' | 'difficult' | 'very_difficult' | 'insufficient_text'
  hardForLayReader: boolean
  note: string
}

const round = (value: number, places = 1) => Math.round(value * 10 ** places) / 10 ** places

export function readabilityStats(text: string): ReadabilityResult {
  const words = text.match(/[A-Za-z][A-Za-z'’-]*/g) ?? []
  const sentences = sentencesOf(text)
  const empty: ReadabilityResult = {
    words: words.length, sentences: sentences.length, syllables: 0, averageSentenceLength: 0, averageSyllablesPerWord: 0,
    fleschReadingEase: 0, fleschKincaidGrade: 0, jargon: { terms: [], words: 0, share: 0 }, band: 'insufficient_text', hardForLayReader: false, note: readabilityHeuristicNote,
  }
  if (words.length < 5 || sentences.length === 0) return empty
  const syllables = words.reduce((total, word) => total + countSyllables(word), 0)
  const perSentence = words.length / sentences.length
  const perWord = syllables / words.length
  const ease = 206.835 - 1.015 * perSentence - 84.6 * perWord
  const grade = 0.39 * perSentence + 11.8 * perWord - 15.59

  const lower = ` ${words.join(' ').toLowerCase().replace(/[’]/g, "'")} `
  const found: Array<{ term: string; count: number }> = []
  let jargonWords = 0
  for (const term of jargonTerms) {
    const count = lower.split(` ${term} `).length - 1
    if (count > 0) { found.push({ term, count }); jargonWords += count * term.split(' ').length }
  }
  found.sort((a, b) => b.count - a.count || a.term.localeCompare(b.term))
  const share = jargonWords / words.length
  const band = grade <= 8 ? 'plain' : grade <= 12 ? 'moderate' : grade <= 16 ? 'difficult' : 'very_difficult'
  return {
    words: words.length, sentences: sentences.length, syllables, averageSentenceLength: round(perSentence), averageSyllablesPerWord: round(perWord, 2),
    fleschReadingEase: round(ease), fleschKincaidGrade: round(grade), jargon: { terms: found, words: jargonWords, share: round(share, 3) },
    band, hardForLayReader: grade > readabilityThresholds.hardGrade || share > readabilityThresholds.heavyJargonShare, note: readabilityHeuristicNote,
  }
}
