// The advocacy style catalogue (F15). A style changes how one party's counsel delivers an opening or
// closing argument. It never changes what is true: every style text ends with the same guardrail, which
// requires the argument to stay inside the admitted evidence the advocate was given. The texts are
// written here, by code, and fixed per catalogue version. A person picks a style by its id; nobody can
// supply text, so a style can never carry an instruction to invent evidence, coach false testimony or
// lean on a protected characteristic. This file imports no Node module, so the browser build can use it.

export const styleCatalogueVersion = 'advocacy-styles-1'

export const advocacyStyleIds = [
  'moral_appeal', 'pragmatic_dealmaking', 'expert_driven_logic', 'theatrical_storytelling', 'plain_factual', 'concise', 'thorough',
] as const
export type AdvocacyStyleId = (typeof advocacyStyleIds)[number]

export interface AdvocacyStyle {
  id: AdvocacyStyleId
  label: string
  // One line for the screen.
  summary: string
  // The exact text added to the styled party's opening and closing argument requests: the style, then the guardrail.
  text: string
}

// Added to every style by code. It is the same words for every style, and a test checks every text carries it.
export const styleGuardrail = 'This changes how you argue, not what is true. Use only facts, figures, quotations and witness accounts that appear in the admitted evidence you were given, and cite that evidence. Do not state or imply any fact that is not in it, and do not suggest what any witness should say. Do not rely on any person\'s race, religion, sex, age, disability, nationality or any other protected characteristic.'

const bodies: ReadonlyArray<Omit<AdvocacyStyle, 'text'> & { body: string }> = [
  {
    id: 'moral_appeal', label: 'Moral appeal (bounded)', summary: 'Fairness and responsibility, tied to exhibits, measured in tone.',
    body: 'Argue from fairness and responsibility. Frame the dispute around what the jurors\' sense of fairness asks of each party on the admitted facts, and tie every moral point to a specific piece of admitted evidence. Keep the tone measured and respectful, do not insult the other side or any witness, and do not appeal to sympathy or anger beyond what the evidence itself shows.',
  },
  {
    id: 'pragmatic_dealmaking', label: 'Pragmatic dealmaking', summary: 'A practical, reasonable resolution; common ground first.',
    body: 'Argue as a practical problem solver. Start from the points the parties\' accounts already share, say what a reasonable and sensible outcome looks like on the admitted record, and concede a point the admitted evidence clearly supports for the other side where that helps your credibility. Then show why the questions that remain should be answered in your favour.',
  },
  {
    id: 'expert_driven_logic', label: 'Expert-driven logic', summary: 'Question by question, element by element, leaning on expert evidence.',
    body: 'Argue through structured reasoning. Take the questions the jury must answer one at a time, name each element, and show step by step how the admitted evidence, especially any expert or technical evidence, meets or fails it. Explain technical material in plain terms, prefer precision to rhetoric, and say where the evidence is thin.',
  },
  {
    id: 'theatrical_storytelling', label: 'Theatrical storytelling', summary: 'A vivid chronological story; silence in the evidence is stated.',
    body: 'Argue through story. Tell what happened as a vivid, chronological narrative with people, places and turning points, using only details that appear in the admitted evidence. Where the evidence is silent, say so rather than filling the gap. Use rhythm, contrast and memorable phrasing, then connect the story back to each question the jury must answer.',
  },
  {
    id: 'plain_factual', label: 'Plain and factual', summary: 'Neutral language, facts in order, each tied to an exhibit.',
    body: 'Argue in plain, neutral language. State the key facts in order, each tied to a specific exhibit, avoid rhetoric and adjectives, and say what the jury must decide and why those facts answer it.',
  },
  {
    id: 'concise', label: 'Concise', summary: 'A short argument: the few points that matter most.',
    body: 'Be brief. Keep your argument to the few points that matter most, in short paragraphs, without repetition or preamble, and stop when they are made. Aim for roughly half the length you would otherwise use.',
  },
  {
    id: 'thorough', label: 'Thorough', summary: 'Every question and significant exhibit, with the other side\'s best points answered.',
    body: 'Be thorough. Cover every question the jury must answer, address each element and each significant exhibit, and answer the strongest points the other side is likely to make with admitted evidence. Aim for a considerably longer argument than you would otherwise give.',
  },
]

export const advocacyStyles: readonly AdvocacyStyle[] = bodies.map(({ body, ...style }) => ({ ...style, text: `${body} ${styleGuardrail}` }))

// The style-specific paragraph, without the guardrail. The safety scan reads this part, because the guardrail itself
// names the things a style must never do.
export const styleBody = (style: AdvocacyStyle): string => style.text.slice(0, style.text.length - styleGuardrail.length).trim()

export function isStyleId(value: unknown): value is AdvocacyStyleId {
  return typeof value === 'string' && (advocacyStyleIds as readonly string[]).includes(value)
}

export function styleById(id: string): AdvocacyStyle {
  const found = advocacyStyles.find((style) => style.id === id)
  if (!found) throw new Error(`Unknown advocacy style: ${id}.`)
  return found
}

// What a style paragraph must never contain: an instruction to invent or alter evidence, to coach or script testimony, to hide or
// mislead, to ignore the rules the advocate was given, to rely on a protected characteristic, or to carry a figure.
export const unsafeStylePatterns: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: 'fabricating or inventing', pattern: /\b(fabricat\w*|invent\w*|make[- ]?up|made[- ]?up|fake\w*|forg(e|ed|ery)|falsif\w*|embellish\w*)\b/i },
  { name: 'false or misleading content', pattern: /\b(false\w*|lie|lies|lying|perjur\w*|mislead\w*|deceiv\w*|decept\w*|untrue)\b/i },
  { name: 'coaching or scripting testimony', pattern: /\b(coach\w*|rehears\w*|script\w*|prepare the witness|tell the witness|witness should (say|testify))\b/i },
  { name: 'hiding or suppressing evidence', pattern: /\b(conceal\w*|suppress\w*|hide|hidden|destroy\w*|withhold\w*)\b/i },
  { name: 'overriding the rules', pattern: /\b(ignore|disregard|override|bypass|previous instructions|despite the (rules|evidence)|regardless of the (rules|evidence))\b/i },
  { name: 'protected characteristics', pattern: /\b(race|racial|racist|ethnic\w*|religio\w*|gender|sex|sexual\w*|age|aged|elderly|disabilit\w*|nationalit\w*|immigra\w*|accent|skin|colou?r|orientation|pregnan\w*|marital)\b/i },
  { name: 'a figure or digit', pattern: /\d/ },
]

// Every problem found in a style paragraph. Empty means it passed. The catalogue is checked when this module loads and by the tests.
export function styleProblems(style: AdvocacyStyle): string[] {
  const problems: string[] = []
  if (!style.text.endsWith(styleGuardrail)) problems.push('does not end with the guardrail')
  const body = styleBody(style)
  for (const { name, pattern } of unsafeStylePatterns) if (pattern.test(body)) problems.push(`mentions ${name}`)
  if (!/admitted evidence/i.test(style.text)) problems.push('does not require the admitted evidence')
  return problems
}

for (const style of advocacyStyles) {
  const problems = styleProblems(style)
  if (problems.length) throw new Error(`Advocacy style ${style.id} is unsafe: ${problems.join('; ')}.`)
}
