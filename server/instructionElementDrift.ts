type Issue = { issueId: string; elements: Array<{ label: string }> }
type Event = { eventId?: string; type: string; payload: Record<string, unknown> }

// This is a model-consistency guard, not a declaration of governing law. A
// source describing investor reliance cannot add it to the approved elements.
export function instructionElementDriftError(text: string, approved: Issue[] | undefined, events: Event[]) {
  const instruction = events.filter(event => event.type === 'judicial_instruction').at(-1)
  const delivered = instruction?.payload.issueInstructions as Issue[] | undefined
  const issues = instruction ? instruction.eventId && !instruction.payload.withheld && typeof instruction.payload.text === 'string' && instruction.payload.text.trim() && Array.isArray(delivered) ? delivered : undefined : approved
  const unquoted = text.replace(/[“"][^“”"]*[”"]|(?<!\w)'[^']*'(?!\w)/g, ' ')
  const required = unquoted.split(/(?<=[.!?;])\s+/).some(sentence => {
    if (sentence.trim().endsWith('?') || /\b(?:if|would|could|might)\b/i.test(sentence) ||
        /\b(?:incorrect|not true) to say\b|\b(?:need not|does not need to|not required to|must not)\b/i.test(sentence)) return false
    return /\bCrown must (?:still |also )?(?:prove|establish)\b[^.!?;]{0,240}\breliance\b/i.test(sentence) ||
      /\breliance\b[^.!?;]{0,100}\b(?:required|necessary|essential|separate) element\b/i.test(sentence)
  })
  if (!required) return undefined
  if (!issues?.length) return 'A required-element claim needs a usable controlling supplied issue model or delivered instruction; an absent or unusable latest instruction cannot authorize this added requirement.'
  const labels = issues.flatMap(issue => Array.isArray(issue.elements) ? issue.elements.map(element => element.label) : [])
  const supplied = labels.some(label => /\b(?:reliance|relied|rely)\b/i.test(label) && !/\b(?:no|not|without)\b[^;.!?]{0,70}\b(?:reliance|relied|rely)\b|\breliance\b[^;.!?]{0,70}\b(?:not required|unnecessary)\b/i.test(label))
  return supplied ? undefined : 'The draft adds investor reliance as a required element, but the controlling supplied issue elements do not supply that requirement. Describe any source account as evidence or an argument about a supplied element; do not add a proof requirement or decide actual law from the draft.'
}
