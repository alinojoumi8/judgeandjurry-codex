// The preserved fictional metadata control has post-period source citations.
// The first attributed quote keeps its own citation. The second quote and its
// dependent comparison share a unit in the revised inventory.
// Adapt only injected checker rows; never edit the historical capture or draft.
export function resegmentMetadataControl(raw: string) {
  const review = JSON.parse(raw)
  const sourceIds = ['content:3', 'content:4']
  const sources = review.findings.filter((finding: { unitId: string }) => sourceIds.includes(finding.unitId))
  if (sources.length !== 2) throw new Error('Expected two captured source/comparison judgments')
  const failure = sources.find((finding: { status: string }) => ['unsupported', 'contradicted'].includes(finding.status))
  const merged = { ...sources[0], status: failure?.status ?? 'supported', explanation: sources.map((finding: { explanation: string }) => finding.explanation).join(' '),
    citations: sources.flatMap((finding: { citations: unknown[] }) => finding.citations), recordCitations: sources.flatMap((finding: { recordCitations: unknown[] }) => finding.recordCitations) }
  review.findings = review.findings.flatMap((finding: { unitId: string }) =>
    finding.unitId === 'content:3' ? [merged] : sourceIds.includes(finding.unitId) ? []
      : [{ ...finding, unitId: finding.unitId === 'content:5' ? 'content:4' : finding.unitId === 'content:6' ? 'content:5' : finding.unitId }])
  return JSON.stringify(review)
}
