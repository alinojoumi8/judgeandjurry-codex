import { AsyncLocalStorage } from 'node:async_hooks'
import { ModelProviderError, type ModelClient } from '../server/minimax'

// QA transport identity comes from the application's request, never model text.
// Internal corrections and selected-passage reviews retain the originating turn.
export function createTrialRequestScope() {
  const storage = new AsyncLocalStorage<Readonly<{ stage: string; actorId?: string }>>()
  const current = () => {
    const scope = storage.getStore()
    if (!scope) throw new ModelProviderError('QA provider request has no originating trial request; no provider request was sent.', { retryable: false })
    return scope
  }
  return {
    wrap(client: ModelClient): ModelClient {
      return { generateStage: request => storage.run(Object.freeze({ stage: request.stage, actorId: request.courtroomActor?.id }), () => client.generateStage(request)) }
    },
    current,
    opening() {
      const scope = current()
      if (scope.stage !== 'crown_opening' || scope.actorId !== 'crown') throw new ModelProviderError(`Focused Crown-opening scope ends before ${scope.stage}; no provider request was sent for this actor.`, { retryable: false })
      return scope
    },
  }
}
