import { readFile } from 'node:fs/promises'
import type { StageRequest } from '../server/minimax'
import type { StageResult } from '../server/types'

type Control = { id: string; expected: 'passed' | 'failed'; request: StageRequest; draft: StageResult }
export async function juryV173Controls(): Promise<Control[]> {
  const capture = JSON.parse(await readFile('docs/qa/jury/v173-captured-reverse-causal-credit.json', 'utf8')) as { request: StageRequest; result: StageResult }
  const original = structuredClone(capture.result); delete original.grounding
  const clean = () => {
    const draft = structuredClone(original)
    draft.jurors![0].rationale = 'I credit the permitted Mira account after weighing its direct description of the listed condition.'
    draft.jurors![0].mindChangedBecause = 'This is my initial assessment.'
    return draft
  }
  const make = (id: string, expected: Control['expected'], text: string, field: 'title' | 'rationale' | 'mindChangedBecause' = 'rationale'): Control => {
    const draft = clean()
    if (field === 'title') draft.title = text
    else draft.jurors![0][field] = text
    return { id: `v173-${id}`, expected, request: capture.request, draft }
  }
  const noPhrase = make('implicit-crown-proof-negative', 'failed', 'I credit Mira because no incompatible timing is supplied.')
  noPhrase.draft.content = 'I vote guilty, crediting the permitted Mira account.'
  return [
    { id: 'v173-captured-reverse-credit-negative', expected: 'failed', request: capture.request, draft: original },
    make('reverse-bare-credit-negative', 'failed', 'I credit E-001 because no incompatible timing is supplied.'),
    make('forward-bare-credit-negative', 'failed', 'No incompatible timing is supplied, so I credit Mira.'),
    make('coordinated-causal-change-negative', 'failed', "My position is stable because I credit Mira's direct account and no incompatible timing is supplied.", 'mindChangedBecause'),
    make('causal-title-negative', 'failed', 'I credit Mira because no incompatible timing is supplied.', 'title'),
    noPhrase,
    { id: 'v173-independent-current-credit-positive', expected: 'passed', request: capture.request, draft: clean() },
    make('bounded-comparison-positive', 'passed', 'No incompatible timing is supplied.'),
    make('separate-independent-reason-positive', 'passed', 'No incompatible timing is supplied. I credit Mira because the actual account directly describes the listed condition.'),
    make('independent-reason-while-comparison-positive', 'passed', 'I credit Mira because the actual account directly describes the listed condition, while the supplied relative timing remains unknown.'),
    make('causal-criterion-correction-positive', 'passed', 'It is incorrect to conclude I credit Mira because no incompatible timing is supplied.'),
    make('source-credit-and-bounded-non-denial-positive', 'passed', "I credit Mira's permitted account after weighing its direct description of the listed condition. Tavi's stated non-observation does not itself deny receipt."),
  ]
}
