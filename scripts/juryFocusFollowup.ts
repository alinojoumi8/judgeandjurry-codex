// The caller verifies durable file hashes and unchanged candidate sources before
// this policy may authorize a separately identified, fresh-only phase.
export function buildJuryFocusFollowup(parent: any, data: any, receipts: any[]) {
  const refuse = (message: string): never => { throw new Error(`Fresh follow-up refused: ${message}`) }
  if (parent.controls.length !== 72 || parent.fresh.length !== 6) refuse('wrong declared allocation')
  if (parent.settings.model !== 'MiniMax-M3.1-Flash-Preview' || parent.settings.reasoningEffort !== 'high') refuse('model settings changed')
  const controls = data.results.filter((row: any) => row.kind === 'control')
  if (controls.length !== parent.controls.length || new Set(controls.map((row: any) => row.id)).size !== controls.length) refuse('incomplete or duplicate controls')
  for (const job of parent.controls) {
    const row = controls.find((item: any) => item.id === job.id)
    if (!row || row.state !== 'finished' || row.expected !== job.expected || row.review?.status !== job.expected || row.expectedMatched !== true) refuse('control did not match')
  }
  const attempts = data.results.filter((row: any) => row.kind === 'fresh')
  if (data.results.length !== 73 || attempts.length !== 1 || attempts[0].id !== parent.fresh[0].id || attempts[0].state !== 'failed' || attempts[0].generated) refuse('fresh work already completed or allocation changed')
  if (JSON.stringify(data.unexecuted) !== JSON.stringify(parent.fresh.slice(1).map((job: any) => job.id))) refuse('unexecuted inputs changed')
  const failed = receipts.filter(row => row.state !== 'received')
  if (failed.length !== 1 || failed[0].state !== 'failed' || failed[0].caseId !== parent.fresh[0].id || failed[0].requestRole !== 'author' || failed[0].error?.message !== 'Pilot overall deadline reached.' || failed[0].partialResponseBytes !== 0) refuse('not the empty-response deadline failure')
  const received = receipts.filter(row => row.state === 'received')
  const controlIds = new Set(parent.controls.map((job: any) => job.id))
  if (received.some(row => row.httpStatus !== 200 || row.requestRole !== 'checker' || !controlIds.has(row.caseId)) || new Set(received.map(row => row.caseId)).size !== controlIds.size) refuse('control receipts missing or another response exists')
  if (receipts.some(row => !Number.isSafeInteger(row.requestCharacters) || row.requestCharacters < 0)) refuse('invalid character accounting')
  const characters = receipts.reduce((total, row) => total + row.requestCharacters, 0)
  if (data.usage.providerHttpCalls !== receipts.length || data.usage.providerInputCharacters !== characters) refuse('durable receipts and counters disagree')
  const callsLeft = parent.limits.maxCalls - receipts.length
  const charactersLeft = parent.limits.maxInputCharacters - characters
  if (callsLeft < parent.fresh.length * 2 || charactersLeft <= 0) refuse('aggregate budget cannot cover six generation/check pairs')
  return {
    scope: 'Separately identified fictional fresh-only follow-up. The same candidate completed all 72 controls; its original 20-minute run remains failed at its deadline. No completed control or accepted answer is rerun.',
    runtimeScope: 'A separate phase with its own bounded deadline; the original run deadline is not extended or relabelled. Aggregate request and character ceilings remain those of the original plan.',
    nativePlanHash: parent.nativePlanHash,
    settings: structuredClone(parent.settings),
    sourceHashes: structuredClone(parent.sourceHashes),
    originalLimits: structuredClone(parent.limits),
    priorUsage: { providerHttpCalls: receipts.length, providerInputCharacters: characters, incompleteAuthorConsumptionUnknown: true },
    limits: { ...parent.limits, maxCalls: callsLeft, maxInputCharacters: charactersLeft },
    completedControlIds: parent.controls.map((job: any) => job.id),
    controls: [],
    fresh: structuredClone(parent.fresh),
    stopConditions: 'Stop remaining fresh work on any provider/transport failure. Preserve originals, repairs, accepted fields and unexecuted inputs. Independent review can stop the owned worker on unsafe acceptance. No tuning during this phase.',
  }
}
