# Plan: courtroom memory, enforceable rulings, and reviewed legal instructions

Date: October 3, 2026 (America/Toronto)

Status: opt-in implementation delivered and mechanically verified; release gates remain open. See [implementation evidence](../qa/courtroom-realism-tdd.md) and [evaluation protocol](../evals/courtroom-realism.md).

Workspace: D:/myprojects/judgeandjurry-codex. Inspected HEAD: 81d3e8e, plus the existing uncommitted work. Complexity: large. Deliver sequentially, with a working and verified increment at each milestone.

## 1. Requested outcomes and scope

Implement the three improvements discussed with the user:

1. Durable, separate participant memory: each judge, lawyer, witness, and juror receives the record they are entitled to know, with source references and a stable view across long hearings and restarts.
2. Enforceable judicial rulings: questioning, objections, jury absence, evidence restrictions, and instructions change the state of the proceeding and the material available for later decisions.
3. Reviewed legal elements and instructions, followed by live-model evaluation: a run uses a pinned legal packet for its jurisdiction and issues; evaluation measures procedural and factual performance using fictional cases.

The first supported workflow is the existing Ontario criminal jury adapter. Retain the civil and capital-markets workflows and test them for regressions. This delivery does not add other jurisdictions, court filing, sentencing research, real-case prediction, demographic outcome modelling, or a new model provider. Separate models per actor remain a later experiment.

Use the existing evidence matrix, original-source viewer, admission ledger, decision traces, and robustness comparison. Keep private preparation separate from evidence throughout. An actor's concise assessment is a simulated position; it does not become a fact merely because it was stored in memory.

## 2. ECC workflow for planning and implementation

ECC installation inspected: C:/Users/matri/.codex/plugins/cache/ecc/ecc/2.2.3.

| Stage | ECC component | Required use |
| --- | --- | --- |
| Choose the workflow | [ecc-guide](C:/Users/matri/.codex/plugins/cache/ecc/ecc/2.2.3/skills/ecc-guide/SKILL.md) | Resolve the installed guidance from its files. |
| Plan | [plan workflow](C:/Users/matri/.codex/plugins/cache/ecc/ecc/2.2.3/commands/plan.md) | Ground requirements in current code, name dependencies and risks, and define acceptance before implementation. This workflow runs inline; no planner agent is required. |
| Define quality gates | [eval-harness](C:/Users/matri/.codex/plugins/cache/ecc/ecc/2.2.3/skills/eval-harness/SKILL.md) | Specify capability and regression evaluations before prompt or runtime changes. Separate deterministic, model-assisted, and human grading. |
| Implement each increment | [tdd-workflow](C:/Users/matri/.codex/plugins/cache/ecc/ecc/2.2.3/skills/tdd-workflow/SKILL.md) | Demonstrate an intended failing test, make the smallest change that passes it, then refactor. Preserve task-to-test-to-RED/GREEN evidence. |
| Close each milestone | [verification-loop](C:/Users/matri/.codex/plugins/cache/ecc/ecc/2.2.3/skills/verification-loop/SKILL.md) | Verify build, types, lint, tests/coverage, security-sensitive changes, and the actual task diff; report failures and omissions. |

This request is for a plan. ECC's plan workflow also says to wait for confirmation before code changes. A subsequent instruction to implement this plan supplies that confirmation; routine authorised checks should not trigger repeated approval questions.

Implementation must re-read the relevant ECC files if the installed version changes. Use the repository's npm/Vitest/Playwright runners, not invented ECC slash commands or ECC's disabled candidate-execution utilities. The plan-orchestrate skill was inspected but is not needed for this inline Codex workflow; no orchestration command or delegated agent has been invoked.

ECC's TDD skill calls for Git checkpoint commits. At implementation time .git is writable, but the worktree contains substantial pre-existing edits. Baseline diff/status and task evidence are preserved; no mixed checkpoint commit was made. The missing checkpoints are reported explicitly. Never reset or sweep existing changes into a checkpoint. No push or publication is part of this plan.

## 3. Verified starting point

These observations were checked against the current source on October 3, 2026. The last test report is historical evidence, not a new test run.

| Existing mechanism | Remaining gap | Source |
| --- | --- | --- |
| Actor-filtered transcript passed to generation | Generation keeps only the final 30,000 characters; the context API and generation also resolve roles separately. | server/trialEngine.ts:1064 and :312 |
| Saved juror snapshots with issue states and hashes | Snapshots are coarse juror checkpoints; generateModelStage does not load them as durable context for every role. | server/trialEngine.ts:1036 |
| Ledger filtering for excluded, reserved, hidden, and redacted sources | An admission status is not a record of when material was actually presented to a participant; prior event payloads also need current-use restrictions. | server/trialEngine.ts:1019; server/workflowRepository.ts:493 |
| Separate witness questions, objections, rulings, and answers | Autonomous examination currently has one direct and one cross question. A sustained objection marks the entire examination complete; there is no autonomous re-examination loop. | server/trialEngine.ts:505 |
| Motion rulings can create new admission versions | Autonomous effects are applied for granted motions; partial dispositions need explicit structured effects. Ruling, ledger pointer, and transcript writes span multiple operations. | server/trialEngine.ts:685 |
| Instructions assembled deterministically from adapter sections and approved issues | Approval checks structural completeness but does not reject unreviewed placeholder legal elements or pin a reviewed legal packet. | server/trialEngine.ts:425; server/workflowRepository.ts:698 |
| Separate initial and final juror ballots | Changed ballots are assigned the latest deliberation event rather than an event explicitly selected and explained by that juror. | server/trialEngine.ts:830 |
| SQLite snapshots, portable archives, and immutable decision traces | New state and legal-packet references must survive recovery and archive remapping without changing old decisions. | server/workflowRepository.ts:552; server/matterArchiveRepository.ts:6; server/decisionTrace.ts |

The October 2 report records 139 tests, 20 browser checks, and seven completed scripted Full Proceedings. It explicitly distinguishes injected responses from live-model quality. Re-run the baseline before implementation. See docs/qa/2026-10-02-evidence-to-decision.md.

Patterns to mirror:

- Types and validation: server/trialEngineTypes.ts, server/workflowSchemas.ts, and Zod parsing in server/routes/workflow.ts:191.
- Errors and logging: TrialActorError and source-verification failure events in generateModelStage; structured logger.warn calls in hearMotion. New logs should contain IDs, versions, durations, and error codes rather than private passage bodies.
- Persistence: WorkflowRepository parameterised SQLite queries and immutable versions. createAdmissionLedger already opens a transaction; the new transaction boundary must avoid nested BEGIN operations.
- Tests: Vitest cases in tests/trialEngineV2.test.ts and temporary-store/archive tests in tests/archiveV2.test.ts; browser workflows use the existing isolated e2e harness.

## 4. Shared design contracts

Introduce a versioned courtroom protocol in run configuration. Existing runs without the version retain their recorded behaviour and remain readable. New protocol runs are opt-in until all release gates pass. Protocol version, case-model version, legal-packet hash, ledger version, and event sequence identify the inputs to each actor call.

### Record, memory, and context

Add typed contracts in server/trialEngineTypes.ts, with matching client exports and Zod validation:

- ParticipantMemory: schema version, actor and role, through-event sequence, projection version/hash, heard-event references, current usable evidence/purposes, relevant ruling and instruction references, issue assessments, and unresolved questions.
- ActorContextManifest: exact event/source references and hashes, legal-packet hash, retrieval parameters, token budget, and omission indicators used for a model request. Extend ModelAudit with the manifest reference/hash; the existing prompt hash does not cover the entire assembled context.
- CourtroomState: active witness, examination stage, permitted next actor/action, pending question/objection, jury attendance, current ledger, outstanding instruction obligations, and last committed event sequence.
- RulingEffects: explicit question/answer/event targets, exhibit or passage restrictions, permitted/prohibited purposes, issue/party scope, effective sequence, reasons, and authority references.
- ReviewedLegalPacket: jurisdiction and proceeding, count/party/element identities, burden allocations, outcomes, applicable instruction sections, source metadata, review status, reviewer attestation, and content hash. Embed it in immutable case-model JSON; runs pin that model and hash.

Keep the transcript append-only. Distinguish what an actor previously heard from what they may currently rely on. A strike must remain auditable while removing the struck content from usable evidence and invalidating dependent assessments. Do not manufacture human-like forgetting or silently rewrite previous decisions.

Build context from authorised, sequence-bounded records before any summarisation. Use deterministic issue/source retrieval and compact typed projections first; no vector service is required. Preserve reference identities in every summary. Reserve context space for controlling instructions and active restrictions. If necessary material cannot fit, retrieve it explicitly or pause the turn with a recorded limitation instead of silently dropping it.

Evidence, counsel submissions, questions, testimony, procedural rulings, and actor assessments need distinct types. A quoted allegation in an opening or a lawyer's question must not become testimony. Model assessments remain attributed and revisable. Store concise reasons and references, not hidden chain-of-thought.

All actor generation and actor-context API responses must use the same server-side role resolver and context builder. A caller cannot grant a role or expand visibility. The local owner audit remains separate from participant context; its broader access must never become model input by accident.

## 5. Delivery milestones

### M0 — Baseline, contracts, and evaluation fixtures

Dependencies: none. Complexity: medium.

1. Record the existing worktree and baseline checks. Keep current changes and source data intact. Use Codebase Memory for discovery and caller tracing before changing affected symbols.
2. Write the contracts above and behavioural evaluation definitions. Capture test fixtures before changing production logic.
3. Add versioned fixture manifests containing fictional sources, private briefs, approved witness knowledge, legal-packet status, scripted commands, and expected visibility/effects. Start with a limited-purpose document and a sustained objection followed by a replacement question.
4. Add coverage measurement using a Vitest-compatible coverage provider and a documented npm script. The current package has no coverage script/provider. Record the baseline; target at least 80% lines, branches, functions, and statements overall and for new modules. Report any gap instead of claiming the ECC threshold passed. Keep browser scenario coverage separate unless it is actually instrumented.

Acceptance: fixtures and evaluation definitions identify expected behaviour without requiring a preferred verdict; existing baseline failures, if any, are recorded before feature work; new tests demonstrate intended RED results before corresponding production edits.

### M1 — Durable participant memory and one context builder (item 1)

Dependencies: M0. Complexity: high.

1. Add server/actorMemory.ts for typed, deterministic memory projection and server/actorContext.ts for permission-aware context assembly. Reuse actor_snapshots for all supported participant roles; retain a reader for legacy snapshot JSON.
2. Extend source/event presentation records with the recipient scope and effective sequence. Jury knowledge comes from material presented to it, including approved read-ins or agreed facts. Witness knowledge comes from its approved statements and authorised examination material. Counsel preparation and judicial motion access remain role-specific.
3. Route generateModelStage, actorContext, witness generation, deliberation, and ballots through the common builder. Remove the recent-transcript-only dependency after equivalence and privacy tests pass.
4. Rebuild missing or stale memory deterministically from pinned records. Hash the full serialised actor input and save a manifest sufficient to reconstruct it locally. A current restriction always takes precedence over a stale snapshot.
5. Expose a role-filtered memory panel with sources, open questions, active instructions, and projection sequence. The owner can inspect audit information separately without leaking it to another actor.
6. Require a changed ballot to name an actual visible deliberation event and relevant permitted source or instruction. Validate the references and explanation presence; do not claim that reference validation proves psychological causation. Preserve invalid/missing ballots as such.

Acceptance: an early material fact remains available after a transcript exceeds 30,000 characters; private/jury-out/future material never enters a juror request; witnesses cannot acquire another witness's private account; restart/rebuild yields equivalent projections; later restrictions invalidate stale usable content; changed-vote attribution is no longer assigned automatically to the latest event.

### M2 — Judge-controlled hearing and enforceable ruling effects (item 2)

Dependencies: M1. Complexity: high.

1. Add server/courtroomState.ts as a deterministic reducer. Persist a versioned checkpoint plus command receipts. Commands include a unique ID and expected event sequence; retries return the committed result and stale commands fail clearly.
2. Add a repository operation that atomically commits a command receipt, events, ruling effects, ledger version, run ledger pointer, and courtroom state. Refactor transaction-owning helpers as needed. Generate model proposals outside the transaction, then validate their expected sequence at commit. Never hold a database transaction across a provider call.
3. Route manual and autonomous actions through this same command path. Validate actor membership, action authority, phase, and target IDs. Distinguish an explicit owner intervention from a simulated actor action.
4. Implement bounded direct, cross, and re-examination loops with explicit completion. An objection targets a question or eligible answer and suspends the affected action. Sustaining a question objection permits rephrasing or the next question; it does not terminate the witness automatically. Preserve the right to decline additional questioning. A resource limit pauses with an explanation rather than pretending examination finished.
5. Add jury departure/return, exhibit presentation, limited admission, striking, and curative/limiting instruction commands. A return to evidence must respect unresolved objections and outstanding instruction obligations. Jury return receives the appropriate ruling/instruction summary, not the private motion argument.
6. Validate explicit effects for partial and full motion grants. A reserved ruling has no inferred grant/exclusion effect. Bind effects to exact question, answer, exhibit, or passage IDs; never infer substantive legal relief from a heuristic concern label.
7. Apply restrictions in memory projection, retrieval, factual grounding, witness answering, deliberation, ballots, and decision traces. Enforce source/role/purpose references mechanically; use semantic evaluation and review for whether a model actually respected a nuanced purpose limitation.
8. Extend the proceeding UI with current speaker/stage, jury attendance, pending objection, judge ruling form, exhibit status, and clear next actions. Keep source and ruling links visible. Invalid actions are disabled in the UI and rejected by the server.

Acceptance: a complete fictional examination includes multiple questions, an objection, a reasoned ruling, resumed questioning, and re-examination; a limited-purpose exhibit changes all subsequent actor inputs; duplicate commands or restart cannot duplicate a ruling; an injected failure cannot leave the run pointer and ledger inconsistent.

### M3 — Reviewed legal packet and instruction gates (item 3, legal foundation)

Dependencies: M2, using the contracts defined in M0. Complexity: high.

1. Add server/legalPacket.ts. Validate every count/party/element, who bears each applicable burden, standard, permitted outcomes, defences or alternatives where relevant, and required instruction sections. Do not reduce all evidential and legal burdens to a single global flag.
2. Replace placeholder readiness with structured draft/reviewed states and field-specific validation errors. Free-text completion or a checked box alone cannot prove legal correctness. Record what was reviewed, by whom, when, and against which packet hash.
3. Gate new protocol run creation on a complete reviewed packet. Older runs remain viewable and visibly retain their historical status. Fictional development fixtures can use an explicitly labelled fixture review record; that must never appear as lawyer certification.
4. Store authority title, jurisdiction, type, URL, precise section/paragraph, effective/as-of date where known, retrieval date, and verification/review status. Separate legislation, binding/persuasive decisions, guidance, and model instructions. Link reachability alone is not legal currency or proposition verification. Require qualified legal review before describing a packet as legally validated.
5. Assemble the final charge from the pinned packet plus applicable ruling effects and the record. Add a pre-charge checkpoint for counsel's proposed corrections and the judge's response. A material packet amendment creates a new immutable version and requires reapproval; it cannot silently change an existing run.
6. Deliver the exact approved charge to every decision actor. Require instruction acknowledgements/version checks before valid ballots. Support jury questions to the judge through a recorded court process, with supplementary instructions versioned and redistributed consistently.
7. Add a legal readiness editor/status panel and source review links. Block with actionable missing-field messages; distinguish technically complete, reviewer-attested, and legally validated statuses.

Acceptance: placeholder or mismatched packets cannot start a new protocol run; provider retries cannot replace controlling law; all ballots reference the applicable instruction version; packet edits do not alter prior decisions; wrong-jurisdiction and unreviewed-source fixtures fail the appropriate gate.

### M4 — Live-model evaluation and release gates (item 3, behaviour quality)

Dependencies: M1–M3. Complexity: high.

1. Add a reusable evaluation runner around the actual trial engine and ModelClient. Keep deterministic fixtures in the normal test suite; run live-provider checks as a separate, explicitly configured job. Use ECC eval-harness's definition/grading/reporting method without its disabled candidate runner.
2. Create ten compact fictional scenarios covering: limited-purpose evidence, later exclusion, struck testimony, conflicting witness statements, knowledge outside a witness's account, unavailable evidence, jury-out proceedings, missing essential proof, a legal-packet defect, and interruption/recovery. Include paired variants that change legally irrelevant names without changing the underlying record. Review behavioural rubrics independently of desired outcomes.
3. Start with two short live pilot scenarios before the full suite. Configure the existing consent gate and explicit limits on model calls, tokens/cost, retries, and elapsed time. Record the configured provider/model and actual usage. Stop on limits and report incomplete cases; do not silently switch to scripted responses.
4. Grade schema, ordering, access boundaries, citation targets, and persistence with deterministic checks. Grade legal reasoning, witness fidelity, permissible use, and instruction adherence with a defined rubric; model-assisted flags need adjudication for ambiguous failures. Keep unreviewed findings labelled as unreviewed.
5. Report first-attempt success, success within at most three bounded attempts, and three-run consistency separately. Never hide failed attempts by reporting only the best retry. ECC targets are capability pass@3 >= 90% and release-critical regression pass^3 = 100%; these are software evaluation targets, not court-outcome probabilities.
6. Require zero observed critical privacy, fabricated-source, instruction-version, or state-integrity failures in the release suite. A model output that violates a deterministic guard is withheld, audited, and handled through the bounded repair/failure path. Passing a finite suite establishes observed performance only.
7. Publish a local QA report covering all attempts, failures, human-review status, costs, latency, and known gaps. Default-enable the new protocol only after technical gates and the applicable legal/behaviour review are complete.

Acceptance: a fresh run produces a reproducible configuration/input manifest and an honest evaluation report; automated and reviewed judgements remain distinguishable; scripted tests are never labelled live legal-quality validation.

## 6. Data migration, archives, and compatibility

- Reuse existing source blobs, case-model versions, admission versions, events, snapshots, and decision sheets. Add only the SQLite state/command-receipt storage needed for atomic hearing progression. Inspect the current schema version at implementation time and use the next ordered migration; do not hard-code an assumed version from this document.
- Add unique constraints for command identity and run/event sequence, with preflight checks for legacy data. Migration failure must roll back without advancing the database version.
- Introduce archive format 3 for the new mandatory command/state collections, while keeping explicit v1/v2 import support. A v2 archive must not silently acquire missing guarantees or be represented as a new protocol run.
- Import remaps every nested actor/event/question/answer/ballot/source/ledger/model reference. Rebuild derived current projections and their hashes after remapping. Preserve original execution hashes and the import provenance; do not relabel a remapped hash as the original model input hash.
- Test import into a populated database, interrupted migration rollback, and reconstruction without cached projections. Completed runs remain immutable. Rollback means restoring a verified backup with matching blobs, not deleting history or forcing the schema number backwards.
- Recovery and archive behaviour ships with each milestone's new stored state. It is not deferred until the final UI test.

## 7. File plan

All paths below are relative to the workspace. Proposed files do not exist until implementation.

| Files | Planned change |
| --- | --- |
| server/actorMemory.ts; server/actorContext.ts (new) | Participant projections, retrieval, manifests, and common role filtering. |
| server/courtroomState.ts; server/legalPacket.ts (new) | Hearing reducer, command validation, packet readiness and instruction assembly. |
| server/trialEngine.ts; server/trialEngineTypes.ts; server/workflowSchemas.ts | Wire memory, shared commands, effects, run protocol, and typed validation. |
| server/workflowRepository.ts; server/migrations.ts | Atomic command persistence, snapshots, migration and consistency constraints. |
| server/caseWorkflow.ts; server/procedureAdapters.ts; server/authorityRegistry.ts | Reviewed packet/version workflow and adapter-specific rules. |
| server/minimax.ts; server/types.ts; server/grounding.ts | Structured model response fields and restriction-aware grounding as needed, without provider replacement. |
| server/routes/workflow.ts; src/api.ts; src/trialEngineTypes.ts | Readiness, courtroom commands, and filtered memory APIs/client types. |
| server/decisionTrace.ts; server/scenarioComparison.ts | Instruction/context provenance and comparable protocol/packet changes. |
| server/matterArchive.ts; server/matterArchiveRepository.ts | v3 validation/export, v1/v2 compatibility, nested remapping and provenance. |
| src/components/FullWorkflowWorkspace.tsx; src/components/WorkflowEditors.tsx; src/components/GroundingAudit.tsx | Integrate readiness, hearing controls, and audit presentation. |
| src/components/ParticipantMemoryPanel.tsx; src/components/CourtroomPanel.tsx; src/components/LegalReadinessPanel.tsx (new); src/App.css | Focused role, hearing, and legal-packet UI. |
| tests/actorMemory.test.ts; tests/courtroomState.test.ts; tests/legalPacket.test.ts; tests/archiveV3.test.ts (new) | New behaviour and recovery tests. |
| tests/trialEngineV2.test.ts; tests/workflowApi.test.ts; tests/grounding.test.ts; tests/decisionTrace.test.ts; tests/archiveV2.test.ts | Existing-path regression coverage. |
| samples/courtroom-realism/ (new); e2e/courtroom.ts (new); scripts/evaluate-courtroom.ts (new) | Fictional fixtures, full browser journey, and bounded live evaluation. |
| package.json; package-lock.json; vite.config.ts; .github/workflows/ci.yml | Coverage support, new commands, and deterministic CI gates. |
| docs/evals/courtroom-realism.md; docs/qa/courtroom-realism-tdd.md (new); README.md; docs/recovery-and-archives.md | Evaluation definitions, actual RED/GREEN evidence, product behaviour, and compatibility guidance. |

Avoid adding more responsibilities to the already large TrialEngineService. Keep policy/context/reducer modules independently testable, while preserving its public service interface where possible.

## 8. Acceptance test matrix

| ID | User-visible or integrity guarantee | Test target |
| --- | --- | --- |
| A01 | An early fact remains retrievable after a long hearing and restart. | actorMemory unit/integration; captured real engine requests |
| A02 | Jury requests contain no private briefs, jury-out arguments, or future-event facts, including through saved summaries. | actorMemory and workflowApi adversarial fixtures |
| A03 | A witness cannot answer from another witness's private statement or an unauthorised passage. | trialEngineV2 captured requests and testimony checks |
| A04 | A later strike/exclusion removes usable content and invalidates dependent assessments without erasing history. | actorMemory, courtroomState, grounding, decisionTrace |
| A05 | A sustained objection pauses the target question; a replacement question and later examination still work. | courtroomState and browser journey |
| A06 | Partial admission applies exactly the approved exhibit/passage/purpose effects. | courtroomState, workflowApi, grounding |
| A07 | Jury departure/return and pending instructions control what is delivered before questioning or deliberation resumes. | courtroomState and captured actor inputs |
| A08 | Duplicate, out-of-order, wrong-role, and cross-run commands cannot mutate state incorrectly. | repository/API integration with fault injection |
| A09 | A crash during ruling commit leaves either the complete old state or complete new state. | transaction fault injection and restart |
| A10 | Incomplete/unreviewed legal packets block new protocol starts with specific errors. | legalPacket and workflowApi |
| A11 | All decision actors use the pinned charge and applicable supplementary instructions. | captured generation requests; ballot validation |
| A12 | A changed vote identifies a valid, relevant visible event; invalid references are rejected. | ballot and decisionTrace regression |
| A13 | v1/v2 imports remain readable; v3 round-trip preserves references, privacy, and execution provenance. | archiveV2/archiveV3 and populated-store import |
| A14 | Reopening a completed run preserves its decision, original trace, packet and context identifiers. | browser reload/archive journey |
| A15 | Civil/tribunal adapters and the existing Full Proceeding flow still pass. | existing unit, simulation, and browser suites |
| A16 | Live evaluation reports failures, retries, budgets, rubric results, and reviewer status accurately. | evaluation runner tests plus bounded live pilot |

Representative browser journey: create the fictional matter; complete the legal packet; start a protocol run; present a document; hear an admissibility dispute with the jury absent; apply a limited-purpose ruling; return and instruct the jury; resume examination after an objection; finish direct/cross/re-examination; review the charge; deliberate; inspect permitted-use and changed-vote explanations; restart/reopen; export/import and compare the saved result.

For the example, the limited-purpose ruling is supplied as an approved fictional scenario condition. The test verifies that the app enforces it; it does not purport to decide a real document's admissibility.

## 9. Validation and evidence

Commands already present in package.json:

```text
npm test
npm run test:sim
npm run test:arguments
npm run test:ui
npm run typecheck
npm run lint
npm run build
git diff --check
```

During each TDD increment, first run only its relevant test target, record the intended RED result, implement, then rerun that same target for GREEN. At milestone completion run the affected integration/browser suites. Run the full applicable command set once for final delivery; repeat it only for new changes or unresolved failures.

Proposed commands to add, not currently available: npm run test:coverage, npm run test:courtroom, and npm run eval:courtroom. The evaluation command must distinguish scripted and live modes explicitly. Existing npm run test:v2:live can remain a provider smoke test; it is not a substitute for the new behavioural rubric.

Use temporary SQLite databases and fictional corpora. Preserve unrelated servers and data. The browser harness must launch and clean up only its own direct child processes using the established Windows-compatible pattern.

Write docs/qa/courtroom-realism-tdd.md with milestone/task, test target, actual command, intended RED excerpt, GREEN excerpt, coverage, implementation/file hashes or task-only checkpoint IDs, and known gaps. Include a final ECC verification report for build/types/lint/tests/security/diff. Do not record secret values or private input bodies in generic logs.

## 10. Risks and release decisions

| Risk | Mitigation / decision |
| --- | --- |
| Private material leaks through memory, old events, or an audit object | One context builder; filter before summarisation; test every model-input route and role view with distinctive fictional secrets. |
| A model obeys citation syntax while violating a limited purpose | Deterministic access/reference checks plus explicit semantic rubrics and qualified review; report the distinction. |
| Stale snapshot or partial transaction resurrects excluded material | Sequence/ledger-bound projections, atomic commits, idempotent commands, and restart/fault tests. |
| Legal packet looks certified merely because fields are filled | Separate technical readiness, reviewer attestation, and legal validation; retain source and review provenance. |
| Live-model evaluation overfits or becomes expensive | Hold out scenarios; bounded pilots; explicit budgets; log all attempts and latency. |
| A new protocol changes old results or breaks archive imports | Pin versions, support legacy readers, add v3 explicitly, and test immutable completed runs. |
| Existing dirty changes or unavailable Git writes confuse evidence | Preserve the starting worktree; record task-owned files/hashes; report unavailable ECC checkpoints. |

Software work can proceed on the fictional fixtures and deterministic gates. Legal validation remains pending until a qualified reviewer actually reviews the selected packet and nuanced behavioural rubric. Do not present that review as completed by a model or by this planning exercise.

## 11. Procedural references for implementation

These are design references, not a substitute for selecting and reviewing the law applicable to each charge. Retrieval was checked on October 3, 2026; retrieval date alone does not establish currency of every proposition.

- The [Ontario Superior Court criminal guide](https://www.ontariocourts.ca/scj/wp-content/uploads/2024/12/Self-Rep-Guide-Criminal.pdf), printed pages 22–23 and 28, describes questioning/re-examination and submissions on contested exhibit admissibility in the jury's absence. Use it to ground the hearing sequence, then verify any specific rule in the applicable primary authority.
- The [NJI/CJC model jury instruction index](https://www.nji-inm.ca/index.cfm/publications/model-jury-instructions/?langSwitch=en) includes limited-purpose evidence, jury exclusion, prior inconsistent statements, duties of judge/jury, elements, burdens, and jury questions. The index was retrieved; applicable full instructions and their currency still need review when building a packet.
- The [Ontario Crown Prosecution Manual](https://www.ontario.ca/document/crown-prosecution-manual) describes the Crown's fairness and objectivity duties. Use these in the actor rubric rather than rewarding conviction rates.

## 12. Completion checklist and implementation handoff

- [x] M0 baseline, contracts, fixture manifests, and evaluation definitions recorded.
- [ ] M1 durable memory, common context construction, and ballot attribution verified.
- [ ] M2 complete hearing loop, ruling effects, atomicity, and recovery verified.
- [ ] M3 packet readiness, reviewed instructions, amendment history, and UI verified.
- [x] M4 bounded live pilot and review status reported without overstating results; full live suite and human review remain open.
- [x] A01–A16 have recorded evidence or an explicit unresolved status.
- [x] Legacy workflows and archive compatibility pass.
- [x] ECC TDD evidence and final verification report are saved; checkpoint limitations are explicit.

M1–M3 software mechanics and UI are implemented and tested; their boxes remain open for the broader acceptance gates, including qualified legal review. The ECC follow-up implements passage/issue/party/purpose projection and reference enforcement, fixes source-drift and ballot-recovery regressions, clears dependency vulnerabilities, and passes the 80% aggregate coverage gate. See [the follow-up verification](../qa/courtroom-hardening.md). Remaining acceptance work is successful bounded live evaluation and independent behavioral/qualified packet review. The protocol remains opt-in. Scripted success does not close the live-quality gate.
