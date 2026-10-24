type Issue = { issueId: string; elements: Array<{ label: string }> }
type Event = { eventId?: string; type: string; payload: Record<string, unknown> }

// This is a model-consistency guard, not a declaration of governing law. A
// source describing investor reliance cannot add it to the approved elements.
export function instructionElementDriftError(text: string, approved: Issue[] | undefined, events: Event[]) {
  const instruction = events.filter(event => event.type === 'judicial_instruction').at(-1)
  const delivered = instruction?.payload.issueInstructions as Issue[] | undefined
  const issues = instruction ? instruction.eventId && !instruction.payload.withheld && typeof instruction.payload.text === 'string' && instruction.payload.text.trim() && Array.isArray(delivered) ? delivered : undefined : approved
  const unquoted = text.replace(/[“"][^“”"]*[”"]|(?<!\w)'[^']*'(?!\w)/g, ' ')
  // A coordinated independent evidential predicate does not extend the earlier
  // must-prove object. Lists and relative clauses remain inside that object.
  const subjectWord = String.raw`(?!(?:that|which|who|whose|where|when|and|or|must)\b)[\p{L}\p{N}'’-]+`
  const evidentialReliance = String.raw`(?:${subjectWord}\s+){0,6}reliance(?:\s+(?:on|upon|in)\s+(?:${subjectWord}\s+){0,9}${subjectWord})?\s+(?:supports?|shows?|suggests?|indicates?|bears? on|is (?:evidence|relevant))\b`
  const boundaries = new RegExp(String.raw`(?<=[.!?;])\s+|\s+(?:but|yet|whereas|however)\s+|,\s*and\s+(?=(?:the\s+)?Crown\b)|,\s*(?:and|or)\s+(?=${evidentialReliance})`, 'iu')
  const required = unquoted.split(boundaries).some(sentence => {
    if (sentence.trim().endsWith('?') || /\b(?:if|would|could|might)\b/i.test(sentence) ||
        /\b(?:incorrect|not true) to say\b|\b(?:need not|does not need to|not required to|must not)\b/i.test(sentence)) return false
    // Remove only the reliance occurrence whose own predicate denies a
    // requirement. A separate positive requirement must still be checked.
    const requirements = sentence.replace(/\breliance\b(?=\s+(?:(?:is|are|was|were|remains?)\s+)?(?:not|never)\s+(?:(?:an?|the)\s+)?(?:(?:listed|required|necessary|essential|separate)\s+)*(?:element|required|necessary|essential)\b)/gi, ' ')
    return /\bCrown must (?:still |also )?(?:prove|establish)\b[^.!?;]{0,240}\breliance\b/i.test(requirements) ||
      /\breliance\b[^.!?;]{0,100}\b(?:required|necessary|essential|separate) element\b/i.test(requirements)
  })
  if (!required) return undefined
  if (!issues?.length) return 'A required-element claim needs a usable controlling supplied issue model or delivered instruction; an absent or unusable latest instruction cannot authorize this added requirement.'
  const labels = issues.flatMap(issue => Array.isArray(issue.elements) ? issue.elements.map(element => element.label) : [])
  const supplied = labels.some(label => /\b(?:reliance|relied|rely)\b/i.test(label) && !/\b(?:no|not|without)\b[^;.!?]{0,70}\b(?:reliance|relied|rely)\b|\breliance\b[^;.!?]{0,70}\b(?:not required|unnecessary)\b/i.test(label))
  return supplied ? undefined : 'The draft adds investor reliance as a required element, but the controlling supplied issue elements do not supply that requirement. Describe any source account as evidence or an argument about a supplied element; do not add a proof requirement or decide actual law from the draft.'
}
