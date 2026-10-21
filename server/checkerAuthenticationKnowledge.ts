import type { StageRequest } from './minimax'

export interface AuthenticationKnowledge {
  exhibitId: string
  informationProvided: false
  knowledgeWithinSuppliedRecord: 'unknown'
}

// This describes the actor's supplied information, not a source's actual
// authentication status. Mixed, omitted or contrary setup stays with the auditor.
export function authenticationKnowledgeForAudit(request: StageRequest): AuthenticationKnowledge[] | undefined {
  if (!request.courtroomProtocol || request.stage !== 'juror_ballot' ||
      !request.courtroomActor?.id.startsWith('juror-') || !request.evidence.length) return
  const context = request.groundingContext ?? ''
  const declaredStatus = /\bauthentication status\s*:\s*\S+|\bauthentication status\s+(?:is|was)\s+(?:verified|authenticated|unauthenticated|unknown|not authenticated)\b/i
  if (declaredStatus.test(`${context}\n${request.packet}`)) return
  const lines = context.split(/\r?\n/)
  if (!request.evidence.every(source => lines.some(line => line.trim().startsWith(`${source.exhibitId}:`) &&
    /\bauthentication status (?:is |was )?not supplied\b/i.test(line)))) return
  return request.evidence.map(source => ({ exhibitId: source.exhibitId, informationProvided: false, knowledgeWithinSuppliedRecord: 'unknown' }))
}
