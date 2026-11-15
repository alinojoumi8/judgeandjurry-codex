import { modelCheckTask } from '../server/analysis/modelCheck'
import { ScriptedStructuredClient, type StructuredRequest } from '../server/analysis/structured'

// A scripted checker for the optional tier-2 model check, wrapped around the
// scripted model of the feature under test. Fixtures establish software
// behaviour only: a scripted checker proves the code around the model, never
// how well a live model judges whether a passage supports a statement.

export interface CheckedPassage { exhibit: string; paragraph: number; citedWords: string; paragraphText: string }
export interface CheckedStatement { id: string; statement: string; passages: CheckedPassage[] }

export type CheckVerdict = 'supported' | 'not_supported' | 'cannot_tell'
export interface Decision { verdict: CheckVerdict; reason?: string }

export const isCheck = (request: StructuredRequest<unknown>) => request.task === modelCheckTask

// What the checker was shown: each document of the request is one statement with its cited passages.
export function statementsOf(request: StructuredRequest<unknown>): CheckedStatement[] {
  return request.inputs.map((input) => ({ id: input.id, ...(JSON.parse(input.text) as Omit<CheckedStatement, 'id'>) }))
}

export type Decide = (statement: string, passages: CheckedPassage[]) => Decision | CheckVerdict

// Answers a check request from the statement alone; delegates everything else to the feature's own scripted model.
export function checkerRouter(decide: Decide, base?: (request: StructuredRequest<unknown>) => unknown) {
  return (request: StructuredRequest<unknown>): unknown => {
    if (!isCheck(request)) {
      if (!base) throw new Error(`Unexpected task ${request.task}`)
      return base(request)
    }
    return {
      verdicts: statementsOf(request).map((entry) => {
        const decision = decide(entry.statement, entry.passages)
        const normal = typeof decision === 'string' ? { verdict: decision } : decision
        return { id: entry.id, verdict: normal.verdict, reason: normal.reason ?? '' }
      }),
    }
  }
}

export const clientFor = (router: (request: StructuredRequest<unknown>) => unknown, calls = 80) =>
  new ScriptedStructuredClient(Array.from({ length: calls }, () => router))

export const checkCalls = (client: ScriptedStructuredClient) => client.calls.filter((call) => isCheck(call.request))
export const otherCalls = (client: ScriptedStructuredClient) => client.calls.filter((call) => !isCheck(call.request))

// The whole prompt a check call would have sent.
export const promptText = (call: ScriptedStructuredClient['calls'][number]) => `${call.prompt.system}\n${call.prompt.user}`
