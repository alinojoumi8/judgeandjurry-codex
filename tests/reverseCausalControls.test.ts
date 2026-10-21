import { expect, it } from 'vitest'
import { juryV173Controls } from '../scripts/juryV173Controls'
import { MiniMaxClient } from '../server/minimax'
import { groundingUnits, ballotConsistencyUnits } from '../server/grounding'

const controls = await juryV173Controls()
it.each(controls.map(control => [control.id, control] as const))('keeps the composed current control oracle: %s', async (_id, control) => {
  const units = [...groundingUnits(control.draft), ...ballotConsistencyUnits(control.draft)]
  const content = JSON.stringify({ findings: units.map(unit => ({ unitId: unit.id, status: 'analysis', explanation: 'Current assessment.', citations: [], recordCitations: [] })) })
  const client = new MiniMaxClient({ provider: 'minimax', apiKey: 'fictional', baseUrl: 'https://fixture.invalid/v1', model: 'fixture', timeoutMs: 2000, maxRetries: 0 }, undefined, async () => Response.json({ choices: [{ message: { content } }] }))
  expect((await client.reviewGrounding(control.request, control.draft)).status).toBe(control.expected)
})
