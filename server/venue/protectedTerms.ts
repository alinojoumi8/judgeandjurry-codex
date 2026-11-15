// Personas and notes in the jury profile are built from attitudes and
// experience (plan ground rule 7). This screen rejects imported free text that
// names a protected personal characteristic, so such text cannot become
// persona material or sit next to a recommendation. It is a word screen, not a
// legal test: it errs toward refusing and says why.

const terms = [
  'age', 'aged', 'ages', 'elderly', 'young', 'younger', 'older',
  'gender', 'sex', 'sexual', 'male', 'males', 'female', 'females', 'men', 'woman', 'women',
  'race', 'races', 'racial', 'racially', 'ethnic', 'ethnicity', 'ethnicities', 'nationality', 'immigrant', 'immigrants',
  'religion', 'religions', 'religious', 'christian', 'muslim', 'jewish', 'hindu', 'sikh', 'buddhist', 'atheist',
  'disability', 'disabilities', 'disabled', 'pregnant', 'pregnancy', 'marital', 'orientation', 'transgender', 'gay', 'lesbian',
] as const

const pattern = new RegExp(`\\b(?:${terms.join('|')})\\b`, 'i')

// The matched word, or undefined when the text names no protected characteristic.
export function protectedTermIn(text: string): string | undefined {
  return pattern.exec(text)?.[0].toLowerCase()
}

export const protectedTermMessage = (term: string): string =>
  `names a protected personal characteristic ("${term}"). Jury profiles are built from attitudes and experience, so this text was not accepted.`
