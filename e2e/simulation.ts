// Live end-to-end simulation check: boots the real express app with the real
// model client pointed at a scripted OpenAI-compatible HTTP provider, runs a
// full sync simulation (criminal template, 12 jurors, independent secret
// ballots), and asserts the realism pipeline end to end - stage order,
// per-juror ballot calls, per-stage temperatures, hung-jury calibration, and
// the exported report. No real model is required.
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import request from 'supertest'

const dataDir = mkdtempSync(join(tmpdir(), 'judge-jury-live-'))
const providerPort = 11533

process.env.MODEL_PROVIDER = 'openai-compatible'
process.env.OPENAI_COMPATIBLE_BASE_URL = `http://127.0.0.1:${providerPort}/v1`
process.env.OPENAI_COMPATIBLE_MODEL = 'scripted-model'
process.env.OPENAI_COMPATIBLE_API_KEY = 'scripted'
process.env.JUDGE_JURY_DB_PATH = join(dataDir, 'live.sqlite')
process.env.UPLOAD_TMP_DIR = join(dataDir, 'uploads')
process.env.LOG_ENABLED = '0'
process.env.MODEL_TIMEOUT_MS = '5000'
process.env.MODEL_MAX_RETRIES = '0'

const { createApp } = await import('../server/app')

const modelCalls: string[] = []

function jurorNumber(name: string): number {
  return Number(name.replace(/\D/g, '')) || 0
}

function ballotLeaning(name: string): 'crown' | 'defence' {
  return jurorNumber(name) <= 9 ? 'crown' : 'defence'
}

function jurorObject(name: string) {
  const leaning = ballotLeaning(name)
  return {
    juror: name,
    leaning,
    confidence: 70 + (jurorNumber(name) % 5),
    rationale: `${name} weighs the disclosure chronology in E-001 against the ${leaning} theory.`,
    citations: ['E-001'],
    beliefTrail: [
      'after_crown_opening',
      'after_defence_opening',
      'after_rebuttals',
      'final_deliberation',
    ].map((stage) => ({
      stage,
      leaning,
      confidence: 65,
      belief: `View at ${stage} anchored to E-001.`,
      why: 'The exhibit record held.',
      citations: ['E-001'],
    })),
    deliberationRounds: [
      {
        round: 1,
        focus: 'burden of proof',
        exchange: `${name} pressed the E-001 chronology.`,
        responseTo: 'panel split',
        leaning,
        confidence: 68,
      },
      {
        round: 2,
        focus: 'credibility',
        exchange: `${name} held position after the exchange.`,
        responseTo: 'Juror 2',
        leaning,
        confidence: 70,
      },
    ],
    mindChangedBecause:
      'The position stayed stable because the cited exhibit record answered the main doubt raised in deliberation.',
    consistencyWarnings: [],
  }
}

const provider = createServer((req, res) => {
  let body = ''
  req.on('data', (chunk: Buffer) => {
    body += chunk.toString()
  })
  req.on('end', () => {
    const parsed = JSON.parse(body) as {
      messages: Array<{ role: string; content: string }>
      temperature?: number
    }
    const user = parsed.messages.find((message) => message.role === 'user')?.content ?? ''
    const stage = user.match(/^Stage: (\S+)/m)?.[1] ?? 'unknown'
    modelCalls.push(`${stage}@${parsed.temperature}`)

    let payload: Record<string, unknown>
    if (stage === 'juror_ballot') {
      const name = user.match(/exactly ONE object for (Juror \d+)/)?.[1] ?? 'Juror 1'
      payload = {
        title: 'Secret Ballot',
        content: `${name} casts an independent ballot grounded in E-001.`,
        citations: ['E-001'],
        jurors: [
          {
            juror: name,
            leaning: ballotLeaning(name),
            confidence: 66,
            rationale: `${name} votes on the E-001 chronology alone.`,
            citations: ['E-001'],
          },
        ],
      }
    } else if (stage === 'jury_deliberation') {
      const names = Array.from(new Set(user.match(/Juror \d+(?=:)/g) ?? []))
      payload = {
        title: 'Jury Deliberation',
        content: 'The panel deliberated over the E-001 chronology and split.',
        citations: ['E-001'],
        jurors: names.map((name) => jurorObject(name)),
      }
    } else if (stage === 'judge_ruling') {
      payload = {
        title: 'Judge Synthesis',
        content:
          'Applying the charge and the deliberation record, the panel did not reach unanimity on the E-001 chronology.',
        citations: ['E-001'],
        jurors: [],
        verdict: {
          outcome: 'Hung jury - no verdict',
          confidence: 90,
          keyFactors: ['The E-001 chronology divided the panel.'],
          unresolvedIssues: [],
          recommendedNextSteps: ['Review disclosure with counsel.'],
          citationWarnings: [],
        },
      }
    } else {
      payload = {
        title: `Stage ${stage}`,
        content: `Substantive ${stage} analysis citing E-001 and responding to the strongest prior opposing point on the record.`,
        citations: ['E-001'],
        jurors: [],
      }
    }

    res.setHeader('content-type', 'application/json')
    res.end(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify(payload) } }],
      }),
    )
  })
})

await new Promise<void>((resolve) => provider.listen(providerPort, '127.0.0.1', resolve))

const failures: string[] = []
function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`PASS ${label}`)
  } else {
    failures.push(label)
    console.log(`FAIL ${label}${detail ? ` :: ${detail}` : ''}`)
  }
}

let closeStore = () => {}
try {
  const app = createApp()
  closeStore = () => {
    ;(app.locals.store as { close(): void }).close()
  }

  const created = await request(app)
    .post('/api/matters')
    .send({
      title: 'Live Criminal Matter',
      narrative: 'Crown alleges fraud against the accused; reasonable doubt is contested.',
    })
    .expect(201)
  const matterId = created.body.activeMatter.id as string

  await request(app)
    .post(`/api/matters/${matterId}/evidence`)
    .attach('file', Buffer.from('Disclosure chronology and bank records.'), 'disclosure.txt')
    .expect(201)

  const options = await request(app).get('/api/run-options').query({ matterId }).expect(200)
  check(
    'criminal template inferred with 12-juror default and secret ballots',
    options.body.defaults.templateId === 'criminal_defence' &&
      options.body.defaults.jurorCount === 12 &&
      options.body.defaults.deliberationMode === 'independent',
    JSON.stringify(options.body.defaults),
  )

  const simulation = await request(app)
    .post(`/api/matters/${matterId}/simulations`)
    .send({ mode: 'sync', runConfig: options.body.defaults })
    .expect(201)

  const session = simulation.body
  check('simulation completed', session.status === 'completed', session.status)
  check('nine stages produced turns', session.turns.length === 9, String(session.turns.length))

  const stageOrder = session.turns.map((turn: { stage: string }) => turn.stage)
  check(
    'realistic stage order (crown first, charge before deliberation)',
    stageOrder.indexOf('crown_opening') < stageOrder.indexOf('defence_opening') &&
      stageOrder.indexOf('jury_instructions') < stageOrder.indexOf('jury_deliberation'),
    stageOrder.join(' -> '),
  )

  const ballotCalls = modelCalls.filter((call) => call.startsWith('juror_ballot'))
  check('12 independent ballot model calls', ballotCalls.length === 12, String(ballotCalls.length))
  check(
    'ballots sampled at temperature 0.7',
    ballotCalls.every((call) => call.endsWith('@0.7')),
    ballotCalls[0],
  )
  check(
    'judge sampled at temperature 0.2',
    modelCalls.includes('judge_ruling@0.2'),
    modelCalls.join(', '),
  )

  check('12 jury opinions stored', session.juryOpinions.length === 12, String(session.juryOpinions.length))
  check(
    'every juror carries a secret_ballot first snapshot',
    session.juryOpinions.every(
      (opinion: { beliefTrail: Array<{ stage: string }> }) =>
        opinion.beliefTrail[0]?.stage === 'secret_ballot',
    ),
  )

  const verdict = session.verdict
  check('hung criminal panel capped at 64% confidence', verdict.confidence <= 64, String(verdict.confidence))
  check(
    'hung panel reported in unresolved issues',
    verdict.unresolvedIssues.join(' ').toLowerCase().includes('hung'),
    verdict.unresolvedIssues.join(' | '),
  )
  check(
    'decision rule surfaced in key factors',
    verdict.keyFactors.join(' ').includes('required agreement'),
    verdict.keyFactors.join(' | '),
  )

  const report = await request(app).get(`/api/sessions/${session.id}/export`).expect(200)
  check(
    'report includes the decision rule and hung status',
    report.body.markdown.includes('Decision rule: unanimous verdict') &&
      report.body.markdown.includes('hung panel'),
  )
  check('report shows the secret ballots', report.body.markdown.includes('secret_ballot'))
} finally {
  provider.close()
  try {
    closeStore()
  } catch {
    // store already closed
  }
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}

if (failures.length > 0) {
  console.error(`\n${failures.length} live end-to-end check(s) failed.`)
  process.exit(1)
}
console.log('\nAll live end-to-end simulation checks passed.')
process.exit(0)
