// Opens the transcript entry for a moment, when the transcript is on the page.
// The transcript lists every saved event under Results.
export function openTranscriptMoment(eventId: string): boolean {
  const target = document.getElementById(`event-${eventId}`)
  if (!target) return false
  target.closest('details')?.setAttribute('open', '')
  target.scrollIntoView?.({ block: 'center' })
  target.setAttribute('tabindex', '-1')
  target.focus()
  return true
}
