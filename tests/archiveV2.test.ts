import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'

import { CaseWorkflowService } from '../server/caseWorkflow'
import { CorpusService } from '../server/corpus'
import { CaseStore } from '../server/db'
import { createMatterArchive, importMatterArchive } from '../server/matterArchive'
import { TrialEngineService } from '../server/trialEngine'
import type { TrialRunConfig } from '../server/trialEngineTypes'

const roots: string[] = []
const previousCorpusRoot = process.env.CORPUS_STORAGE_DIR

afterEach(() => {
  process.env.CORPUS_STORAGE_DIR = previousCorpusRoot
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('matter archive format v2', () => {
  it('round-trips preserved blobs, corpus artifacts, case workflow, events, ballots, and decisions', async () => {
    const root = mkdtempSync(join(tmpdir(), 'judge-jury-archive-v2-'))
    roots.push(root)
    process.env.CORPUS_STORAGE_DIR = join(root, 'blobs')
    const packet = join(root, 'packet')
    mkdirSync(packet)
    writeFileSync(join(packet, 'disclosure.txt'), 'Preserved disclosure for archive v2.')

    const store = new CaseStore(join(root, 'case.db'))
    const matter = store.createMatter({ title: 'Archive v2 fixture', narrative: 'Claim 1: Contract issue.' })
    const corpus = new CorpusService(store, undefined, process.env.CORPUS_STORAGE_DIR)
    const preview = await corpus.previewFolder(packet)
    const job = corpus.confirmPreview(preview.id, matter.id, false)
    await corpus.runToCompletion(job.id)

    const workflow = new CaseWorkflowService(store)
    const draft = workflow.draftCaseModel(matter.id, 'ontario_civil_v1')
    const model = workflow.approveCaseModel(draft.id)
    workflow.saveTheoryBrief({ caseModelId: model.id, partyId: 'plaintiff', side: 'plaintiff', narrative: 'Private archive theory.' })
    const engine = new TrialEngineService(store)
    const config: TrialRunConfig = {
      mode: 'full', procedureAdapter: 'ontario_civil_v1', seed: 'archive-seed',
      checkpointPolicy: { default: 'autonomous', approvalPhases: [], allowCounselTakeover: true },
      actorProviders: { default: { provider: 'local', model: 'fixture' } }, witnessPlan: [],
      deliberation: { maxRounds: 3, concurrency: 2 }, civilDecisionMaker: 'judge_alone',
      externalDisclosureConfirmed: false,
    }
    const run = engine.createRun({ matterId: matter.id, caseModelId: model.id, config }).run
    engine.command(run.id, {
      type: 'record_ballot',
      ballot: {
        issueId: model.decisionIssues[0].id, actorId: 'judge-1', round: 'final', choice: 'proved',
        confidence: 70, rationale: 'Fixture judge-alone finding.', sourceRefs: [], valid: true,
      },
    })
    engine.command(run.id, { type: 'complete_decision' })

    const archive = await createMatterArchive(store, matter.id)
    expect(archive.version).toBe(2)
    expect(archive.blobs).toHaveLength(1)
    expect(archive.snapshot.corpusJobs).toHaveLength(1)
    expect(archive.snapshot.derivedArtifacts).toHaveLength(1)
    expect(archive.snapshot.caseModelVersions).toHaveLength(1)
    expect(archive.snapshot.trialRuns).toHaveLength(1)
    expect(archive.snapshot.issueBallots).toHaveLength(1)
    expect(archive.snapshot.decisionSheets).toHaveLength(1)

    const imported = await importMatterArchive(store, archive)
    expect(imported.id).not.toBe(matter.id)
    expect(store.listEvidence(imported.id)).toHaveLength(1)
    expect(store.workflow.listCaseModels(imported.id)).toHaveLength(1)
    expect(store.workflow.listTheoryBriefs(store.workflow.listCaseModels(imported.id)[0].id)[0].narrative).toBe('Private archive theory.')
    const importedRun = store.workflow.listTrialRuns(imported.id)[0]
    expect(store.workflow.listTrialEvents(importedRun.id).some((event) => event.type === 'decision_sheet_completed')).toBe(true)
    expect(store.workflow.listBallots(importedRun.id)).toHaveLength(1)
    expect(store.workflow.getDecisionSheet(importedRun.id)).toMatchObject({ complete: true })
    const importedEvidence = store.listEvidence(imported.id)[0]
    expect(store.getEvidenceSource(importedEvidence.id).sha256).toBe(importedEvidence.sha256)
    store.close()
  })
})
