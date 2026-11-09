// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { analyseDeliberation, deliberationAlgorithmVersion, deliberationTable, forecastLabel } from '../server/deliberationAnalysis'
import type { CaseStore } from '../server/db'
import { isJudgeDecided } from '../server/procedureAdapters'
import type { DeliberationResponse, DeliberationTableResponse } from '../server/routes/deliberation'
import { AcrossRunsTable, DeliberationScreen, DeliberationView } from '../src/components/analysis/DeliberationView'
import { N, P, forecastRun, jurors, votesFrom, type DeliberationScript } from './deliberationFixtures'

const browserDocument = Reflect.get(globalThis, 'document') as Document
const roots: Array<ReturnType<typeof createRoot>> = []
const stores: CaseStore[] = []

afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount())
  browserDocument.body.replaceChildren()
  vi.unstubAllGlobals()
  for (const store of stores.splice(0)) store.close()
})

const flips = (): DeliberationScript => ({
  vote: votesFrom({ initial: [P, P, P, P, N, N], polls: [[P, P, P, P, P, N]], final: [P, P, P, P, P, N] }),
  movedBy: (juror) => (juror === 'juror-05' ? 'juror-01' : undefined),
  turn: (juror, phase) => {
    if (phase !== 'deliberation_review') return { stance: 'new_point' }
    if (juror === 'juror-01') return { stance: 'challenge', replyTo: 'juror-05' }
    if (juror === 'juror-05') return { stance: 'challenge', replyTo: 'juror-01' }
    if (juror === 'juror-06') return { stance: 'challenge', replyTo: 'juror-02' }
    return { stance: 'agree', replyTo: 'juror-01' }
  },
})
const split = (): DeliberationScript => ({ vote: votesFrom({ initial: [P, P, P, N, N, N], final: [P, P, P, N, N, N] }), turn: () => ({ stance: 'new_point' }) })

async function responseFor(script: DeliberationScript, counts: 'visible' | 'hidden' = 'visible') {
  const run = await forecastRun(stores, script, { config: { strawPollCounts: counts } })
  const store = run.world.store
  const record = store.workflow.getTrialRun(run.runId)
  const issues = store.workflow.getCaseModel(record.caseModelId).decisionIssues.filter((issue) => !isJudgeDecided(issue, record.config.framework))
  const view = analyseDeliberation({
    runId: run.runId, jurorIds: store.workflow.listJurorProfiles(run.runId).map((profile) => profile.actorId),
    issues: issues.map((issue) => ({ id: issue.id, label: issue.label, permittedOutcomes: issue.permittedOutcomes })),
    ballots: store.workflow.listBallots(run.runId), events: store.workflow.listTrialEvents(run.runId), decisions: store.workflow.getDecisionSheet(run.runId)?.decisions,
  })
  const response = JSON.parse(JSON.stringify({
    runId: run.runId, simulated: true, label: forecastLabel, algorithmVersion: deliberationAlgorithmVersion, enabled: true, available: true, strawPollCounts: counts, view,
  })) as DeliberationResponse
  return { response, run }
}

async function mountScreen(response: DeliberationResponse | null, extra: { error?: string; onOpenMoment?: (id: string) => boolean } = {}) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const element = browserDocument.createElement('div')
  browserDocument.body.append(element)
  const root = createRoot(element)
  roots.push(root)
  await act(async () => root.render(createElement(DeliberationScreen, { response, error: extra.error ?? '', headingId: 'dv', onOpenMoment: extra.onOpenMoment ?? (() => true) })))
  return element
}
const text = (root: Element) => root.textContent ?? ''
const rows = (table: Element) => [...table.querySelectorAll('tbody tr')].map((row) => [...row.children].map((cell) => cell.textContent ?? ''))
const tableWith = (root: Element, caption: RegExp) => [...root.querySelectorAll('table')].find((table) => caption.test(table.querySelector('caption')?.textContent ?? ''))!

describe('the deliberation screen', () => {
  it('says plainly that everything on it is simulated and private, and whether the jurors were told the counts', async () => {
    const shown = await mountScreen((await responseFor(flips(), 'visible')).response)
    const note = shown.querySelector('[role="note"]')!
    expect(note.textContent).toMatch(/Simulated — model output playing jurors, with every position counted in code\./)
    expect(note.textContent).toMatch(/private to this audit view/)
    expect(note.textContent).toMatch(/straw-poll counts, which the simulated jurors were told/)
    const hidden = await mountScreen((await responseFor(flips(), 'hidden')).response)
    expect(hidden.querySelector('[role="note"]')!.textContent).toMatch(/the simulated jurors were not told the straw-poll counts/)
    expect(hidden.textContent).toMatch(/Jurors were not told these counts/)
  })

  it('shows the vote by round with counts as text beside every bar, and hides the bars from assistive technology', async () => {
    const root = await mountScreen((await responseFor(flips())).response)
    const table = root.querySelector('table')!
    expect(table.querySelector('caption')!.textContent).toMatch(/Vote by round: Fictional question claim/)
    expect([...table.querySelectorAll('thead th')].map((cell) => cell.textContent)).toEqual(['Vote', 'Share of valid votes', 'not proved', 'proved', 'Not counted', 'Transcript'])
    const body = rows(table)
    // Each count cell carries the count and its share of the valid votes, as text.
    expect(body.map((row) => [row[0]!.replace(/Jurors were (not )?told these counts/, ''), row[2], row[3], row[4]])).toEqual([
      ['Initial ballot', '233%', '467%', 'None'],
      ['Straw poll after round 1', '117%', '583%', 'None'],
      ['Final ballot', '117%', '583%', 'None'],
    ])
    expect(body[1]![0]).toMatch(/Jurors were told these counts/)
    expect(table.querySelectorAll('.deliberation-view__bar')).toHaveLength(3)
    for (const bar of table.querySelectorAll('.deliberation-view__bar')) expect(bar.getAttribute('aria-hidden')).toBe('true')
    // Only the poll links to the transcript; the ballots are private.
    expect(table.querySelectorAll('button')).toHaveLength(1)
    expect(table.querySelector('button')!.getAttribute('aria-label')).toBe('Open transcript moment: Straw poll after round 1')
  })

  it('lists each juror\'s vote at each stage in a labelled table', async () => {
    const root = await mountScreen((await responseFor(flips())).response)
    const detail = [...root.querySelectorAll('details')].find((item) => /How each juror voted/.test(item.textContent ?? ''))!
    const table = detail.querySelector('table')!
    expect(rows(table).find((row) => row[0] === 'juror-05')).toEqual(['juror-05', 'not proved', 'proved', 'proved'])
    expect(rows(table).find((row) => row[0] === 'juror-06')).toEqual(['juror-06', 'not proved', 'not proved', 'not proved'])
  })

  it('shows the camps, the friction with its total, the holdout and who moved whom', async () => {
    const { response } = await responseFor(flips())
    const root = await mountScreen(response)
    expect([...root.querySelectorAll('.deliberation-view__camps li')].map((item) => item.textContent)).toEqual([
      'Camp 1: 5 jurorsjuror-01, juror-02, juror-03, juror-04, juror-05Fictional question claim: proved',
      'Camp 2: 1 jurorjuror-06Fictional question claim: not proved',
    ])
    expect(text(root)).toMatch(/Friction score 5 from 3 unresolved challenges of 3\./)
    expect(text(root)).toMatch(/Highest: juror-01 and juror-05 \(4\); juror-02 and juror-06 \(1\)\./)
    const challenges = tableWith(root, /Challenges, each judged/)
    expect(rows(challenges).map((row) => [row[1], row[2], row[4]]).sort((a, b) => a[0]!.localeCompare(b[0]!))).toEqual([
      ['juror-01 challenged juror-05', 'Straw poll after round 1 to final ballot', '2'],
      ['juror-05 challenged juror-01', 'Straw poll after round 1 to final ballot', '2'],
      ['juror-06 challenged juror-02', 'Straw poll after round 1 to final ballot', '1'],
    ])
    const holdouts = tableWith(root, /never changed their answer/)
    expect(rows(holdouts)[0]!.slice(0, 4)).toEqual(['juror-06', 'Fictional question claim', 'not proved', 'proved: 5 of 6 jurors'])
    const moves = tableWith(root, /Changes between two valid votes/)
    expect(rows(moves)[0]![0]).toBe('juror-05')
    expect(rows(moves)[0]![2]).toMatch(/^not proved to proved/)
    expect(rows(moves)[0]![3]).toBe('juror-01 (new point)')
    expect(text(root)).toMatch(/juror-01 moved juror-05\./)
  })

  it('reports no agreement as it is, with no holdouts and no friction to invent', async () => {
    const { response } = await responseFor(split())
    const root = await mountScreen(response)
    const none = root.querySelector('.deliberation-view__none')!
    expect(none.getAttribute('role')).toBe('status')
    expect(none.textContent).toMatch(/no agreement/)
    expect(none.textContent).toMatch(/Final ballots: not proved 3, proved 3/)
    expect(none.textContent).toMatch(/No consensus was forced/)
    expect(text(root)).toMatch(/No holdouts/)
    expect(text(root)).toMatch(/No juror changed their answer/)
    expect(text(root)).toMatch(/No challenge named another juror's contribution/)
    expect(text(root)).toMatch(/2 camps at the final ballot/)
  })

  it('opens the transcript at a saved moment, and says so when the transcript is not on the page', async () => {
    const { response } = await responseFor(flips())
    const opened: string[] = []
    const root = await mountScreen(response, { onOpenMoment: (id) => { opened.push(id); return opened.length < 3 } })
    const buttons = [...root.querySelectorAll('button')]
    const poll = buttons.find((button) => button.getAttribute('aria-label') === 'Open transcript moment: Straw poll after round 1')!
    await act(async () => poll.click())
    expect(opened).toEqual([response.view!.votePaths[0]!.stages[1]!.eventId])
    const holdout = buttons.find((button) => /Last contribution of juror-06/.test(button.getAttribute('aria-label') ?? ''))!
    await act(async () => holdout.click())
    expect(opened[1]).toBe(response.view!.holdouts[0]!.lastTurn!.eventId)
    const move = buttons.find((button) => /Contribution that moved juror-05/.test(button.getAttribute('aria-label') ?? ''))!
    await act(async () => move.click())
    expect(opened[2]).toBe(response.view!.moves[0]!.cause.eventId)
    expect(text(root)).toMatch(/The transcript is not open on this page/)
  })

  it('shows the derived roles, weights and speaking order without claiming the foreperson controls a vote', async () => {
    const { response } = await responseFor(flips())
    const root = await mountScreen(response)
    expect(text(root)).toMatch(/The foreperson presides and does not control any vote/)
    expect(text(root)).toMatch(/A stated heuristic, not a measurement/)
    const detail = [...root.querySelectorAll('details')].find((item) => /Jurors, derived roles and turns taken/.test(item.textContent ?? ''))!
    expect(rows(detail.querySelector('table')!)).toHaveLength(6)
    expect(text(detail)).toMatch(/inventory, round 1: 1\. juror-0\d/)
    expect(text(root)).toMatch(/18 deliberation turns: 18 with a recorded stance \(agree 3, challenge 3, new point 12\), 6 naming the contribution they answer\./)
    expect(response.view!.jurors.map((juror) => juror.jurorId)).toEqual(jurors)
  })

  it('shows why nothing is available, an error, and a loading state', async () => {
    const base = { runId: 'r', simulated: true, label: forecastLabel, algorithmVersion: deliberationAlgorithmVersion, enabled: true, strawPollCounts: 'visible' } as const
    expect(text(await mountScreen({ ...base, available: false, reason: 'Private votes appear once the run has completed.' }))).toMatch(/appear once the run has completed/)
    expect((await mountScreen(null, { error: 'Trial run not found: x' })).querySelector('[role="alert"]')!.textContent).toMatch(/not found/)
    expect(text(await mountScreen(null))).toMatch(/Loading the deliberation forecast/)
  })
})

describe('the table across runs', () => {
  const ballots = (initial: string[], final: string[]) => jurors.flatMap((actorId, index) => [
    { issueId: 'claim', actorId, round: 'initial' as const, choice: initial[index]!, valid: true }, { issueId: 'claim', actorId, round: 'final' as const, choice: final[index]!, valid: true },
  ])
  const issue = { id: 'claim', permittedOutcomes: ['proved', 'not_proved', 'no_decision'] }
  const table = deliberationTable([
    { runId: 'a', seed: 'a', status: 'completed', jurorIds: jurors, issues: [issue], ballots: ballots([P, P, P, P, N, N], [P, P, P, P, P, N]), decisions: [{ issueId: 'claim', outcome: P, complete: true, rule: '5 of 6' }], strawPolls: true },
    { runId: 'b', seed: 'b', status: 'completed', jurorIds: jurors, issues: [issue], ballots: ballots([P, P, P, N, N, N], [P, P, P, N, N, N]), decisions: [{ issueId: 'claim', outcome: 'no_decision', complete: false, rule: '5 of 6' }] },
    { runId: 'c', seed: 'c', status: 'running', jurorIds: jurors, issues: [issue], ballots: [] },
  ])
  const response: DeliberationTableResponse = { matterId: 'm', simulated: true, label: forecastLabel, algorithmVersion: deliberationAlgorithmVersion, filters: {}, runsRead: 3, runsWithStrawPolls: 1, table }

  it('shows how initial splits turned into final outcomes and how often each final split occurred', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    const element = browserDocument.createElement('div')
    browserDocument.body.append(element)
    const root = createRoot(element)
    roots.push(root)
    await act(async () => root.render(createElement(AcrossRunsTable, { response })))
    const [transitions, splits] = [...element.querySelectorAll('table')]
    expect(rows(transitions!)).toEqual([['3 of 6', '1', '0', '0', '1'], ['4 of 6', '1', '1', '0', '0']])
    expect(rows(splits!)).toEqual([['3 of 6', '1', '50%'], ['5 of 6', '1', '50%']])
    expect(element.textContent).toMatch(/3 completed jury runs read \(1 with straw polls\)/)
    expect(element.textContent).toMatch(/Counts of simulated runs, not real verdict probabilities/)
    expect(element.textContent).toMatch(/1 left out/)
    expect(element.textContent).not.toMatch(/juror-0/)
  })
})

describe('loading the deliberation forecast', () => {
  async function mountLoader(runId: string, matterId?: string) {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    const element = browserDocument.createElement('div')
    browserDocument.body.append(element)
    const root = createRoot(element)
    roots.push(root)
    await act(async () => root.render(createElement(DeliberationView, { runId, matterId })))
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    return element
  }
  const stubFetch = (body: unknown, status = 200) => vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })))

  it('fetches the run\'s forecast and shows it, and shows nothing for a run that never used it', async () => {
    const { response } = await responseFor(flips())
    stubFetch(response)
    const shown = await mountLoader(response.runId, 'm1')
    expect(shown.querySelector('h2')!.textContent).toMatch(/Deliberation forecast/)
    expect(shown.textContent).toMatch(/Across all completed runs of this matter/)
    stubFetch({ ...response, enabled: false, available: false, view: undefined, reason: 'The deliberation forecast was not switched on for this run.' })
    expect((await mountLoader('other-run')).querySelector('section')).toBeNull()
  })

  it('shows an error when the request fails', async () => {
    stubFetch({ error: 'Trial run not found: x' }, 404)
    expect((await mountLoader('x')).querySelector('[role="alert"]')!.textContent).toMatch(/not found/i)
  })
})
