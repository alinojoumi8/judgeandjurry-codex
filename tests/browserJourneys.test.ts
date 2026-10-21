import { it } from 'vitest'

// Run the same isolated browser journeys inside Vitest so their API calls count
// toward server branch coverage as well as the separately collected browser map.
it.skipIf(process.env.RUN_BROWSER_COVERAGE !== '1')('executes evidence-to-decision and courtroom recovery through the browser', async () => {
  await import('../e2e/arguments')
  await import('../e2e/courtroom')
  await import('../e2e/smoke')
}, 300_000)
