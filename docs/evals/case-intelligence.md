# Case intelligence evaluation

Two commands check the case intelligence features (court rules, jury profile, case map, timeline and key facts, evidence index, expert assessment, case summaries, juror journey, deliberation forecast, forecast study, improvement plan). Both use the fictional civil negligence fixture in `samples/civil-negligence/` and `samples/venue-fictional/`. **Fixtures establish software behaviour only. They are never evidence that a live model reads real documents correctly, and they are never external integration proof.**

## Browser journey: `npm run test:intelligence`

`e2e/case-intelligence.ts` is one serial Playwright journey on a temporary SQLite database, evidence directory and preview directory (deleted at the end, never a user's matter database). Scripted in-process models stand in for every provider, and the script replaces `fetch` so that any request leaving loopback is refused and counted; the run fails if one occurs.

It checks, in order, with a reload after each saved state:

1. The matter opens with 19 preserved sources and an approved case model, and the navigation lists every built area.
2. Court rules: the Ontario civil pack is chosen, the "not reviewed by a lawyer" banner shows, the panel and decision rule show, and the choice survives a reload.
3. Local jury profile: four fictional datasets are imported, a profile is built, approved and sampled, a dataset used by the approved profile cannot be deleted, and the fingerprint is the same after a reload.
4. Case Map: a cost preview comes before any model call, one call per pleading, source links, a judge-only mark, approval.
5. Facts & Evidence: timeline (preview, 47 events, unknown dates stay unknown, allegations labelled not proof, conflict side by side, filters, edit, refused impossible date, review, approve, promote to a new draft model), readings (refused plainly without admission settings and with no call; then labelled simulated), evidence index (allegations say Not evidence, proposals change nothing until accepted, coverage, record gaps, search, approve), expert witnesses (indicators, unknown admissibility, approve).
6. Case summaries for two parties: each side's own summary, no cross-side theory or canary, citations that open the preserved passage, approve, an explicit use-as-theory step that changes nothing until confirmed, Markdown and HTML exports with the unreviewed-rules notice. Step 6b writes the plaintiff's summary again with the optional model check ticked (a scripted checker confirms one theory sentence and cannot tell on another): the verdict badges, the left-out sentence named in the use-as-theory preview, the opt-in box off by default, the preview fetched again when it is ticked and unticked, the tagged sentence only while ticked, and the saved case model draft and the summary's record of the unconfirmed sentence before and after a reload. The same step asserts the on-screen line "Model check when this was used as theory: 1 sentence carried, 1 not confirmed, 0 not checked, 0 left out" after the confirmation and after a reload (and its absence in step 6 where no check was run), and the note on the Private theories screen for a theory carrying the tag. Step 6c writes the defendant's summary with the check ticked and an extra theory sentence, and the scripted checker answers one batch in a reply that does not match its schema (the way a failed check reaches the product): that batch's sentences are badged "Not checked", the summary note counts them, the use-as-theory preview leaves the not-checked theory sentence out by default and names it "Not checked" (not "Not confirmed"), and ticking the opt-in tags it "[not checked by model check]"; the step cancels, so it saves no case model.
7. Run simulation with juror cognition and the deliberation forecast on: the cost preview rises as settings are turned on and equals the shared arithmetic; a scripted run makes exactly the previewed appraisal and straw-poll calls; Results shows the Juror journey and Deliberation forecast labelled Simulated; they survive a reload; no private theory canary reaches a juror request.
8. Strategy: a forecast study (cost preview, seeded panels through the queue, tables, the "not yet tested against real outcomes" sentence on screen and in both exports, approve) and a case improvement plan (a fabrication instruction is refused with a 422 and no call, preview, register sorted by severity, hypotheticals labelled, approve, exports, evidence and ledgers unchanged).
9. Case Map apply: the map approved earlier is out of date once a newer model is approved and cannot be applied; a new map is made, approved and applied as a new draft model, leaving approved versions alone.
10. No console error, no unexpected failed API response (each deliberate refusal is declared where it is caused), and nothing left this machine.

The report is written to `tmp/qa/intelligence/browser/report.json` with screenshots.

### Extension points

The journey has two clearly marked lists for work that belongs to other tasks: `afterForecast` (damages modelling and caps, jury psychology on damages; still empty) and `afterImprovementPlan` (style-based strategy studies; **filled by M8 part B**: it opens the Style studies tab, checks that every style's exact text is on screen with the label, previews the cost before any run and checks that the figure equals the API's, runs an eight-seed paired study of two styles through the queue, checks that a style text appears only in the styled party's own opening request, declares and checks the 400 for a style that is not in the catalogue, then reloads, exports, approves and reloads again). Steps added there run on the same matter and must keep the same rules: a reload check, the simulation label wherever a number shows, declared refusals only, and scripted replies added to the shared router.

### What it does not establish

The optional tier-2 model check (`modelCheck: true`, off by default) is exercised by unit, API and screen tests with a scripted checker (`tests/modelCheck*.test.ts`) and is part of the browser journey only in steps 6b (verdicts confirmed and not confirmed, with the saved record) and 6c (a failed check, so "Not checked"), each with a scripted checker; the scripted evaluation runs with it off. A scripted checker proves the code around the model: batching, the cost estimate, rejecting, flagging and leaving items unchecked, cap handling, prompt contents and the privacy of what is sent. It says nothing about how well a live model judges whether a passage supports a statement, or whether it resists a planted instruction; those are not verified. Model quality, legal correctness, live provider behaviour, calibration, or that jurors would behave as the scripted ones do. The journey drives a few fixture edits through the model service or the API where the screen has no editor (the Ontario eligibility override, each side's private theory, the jury notice confirmation, disclosure analysis); each is marked in the script.

## Scripted evaluation: `npm run eval:intelligence`

`scripts/evaluate-case-intelligence.ts` runs the real services (`ChronologyService`, `CaseMapService`, `EvidenceIndexService`, `ExpertAssessmentService`) against a scripted structured client and scores what they save against `samples/civil-negligence/answer-key.json`.

Scored (targets in `scripts/case-intelligence-thresholds.json`, the only place they are set, proposed at 90 percent each and **unverified against a live model**):

| Family | Metrics |
| --- | --- |
| Chronology | event recall and precision, date accuracy, conflict recall and precision |
| Case map | item recall and precision, kind accuracy (claims, defences, crossclaim, relief, allegations), who pleads against whom, crossclaim direction |
| Evidence index | record gap recall and precision |
| Experts | planted weakness recall, opinion recall, stated-qualification accuracy |

Notes on scoring: conflict scoring covers only the key topic the chronology is designed to flag (a time conflict, `C1`); the other nine key topics are disagreements about substance and are listed as out of scope in every report. A gap counts as found when it cites the same paragraph of the same document as the key's pointer. Key event `CH12` gives a triage time on a date the cited passage does not state; the software leaves that date unknown, so date accuracy is 41 of 42 with a perfect client. Expert weakness recall is mostly satisfied by code indicators, so it says little about the model. A cited passage matches a key passage only when the shorter quotation is at least 12 characters (or the whole of a shorter one) and sits inside the longer, so empty or one-word fragments earn no recall or precision.

Two clients run every time. The **key client** returns the answer key and must meet every target. The **degraded client** is deliberately wrong (half the events lost, dates shifted, a non-key passage added, who pleads against whom reversed, the crossclaim turned into a denial, no index entries or findings) and the harness fails unless it misses targets in all four families. That is what stops the scorer passing vacuously. A third probe runs the real chronology service with a model that flags one false conflict between two valid, unrelated events: conflict precision must fall below target while the true time conflict still counts, because a flagged conflict is correct only when its events cite the sides of a key conflict.

Invariants, each calling the real services with controls that show the check can fail:

- INV-1 no timeline event without a checked source passage
- INV-2 unknown dates stay unknown, and a date the passage does not state is refused
- INV-3 allegations are never counted as evidence
- INV-4 excluded material is absent from every input a juror-lens reading is built from
- INV-5 the planted prompt-injection line is delimited as data, kept out of instructions, and absent from every saved output (this shows the software's framing only; it does not show a live model would resist the line)
- INV-6 hypothetical improvement-plan material never reaches the evidence store, admission ledgers, case models or other artifacts
- INV-7 the forecast label is present on the view, in the stored artifact and in both exports
- INV-8 a style study recovers a planted style effect, reports a planted null as null, puts a style text only in the styled party's own advocacy requests, passes the style safety scan (which can fail) and carries the forecast label on the view and in both exports (scripted jurors: this shows the software, not that a live model would respond to a style)

The exit code is non-zero on any missed target by the key client, any failed invariant, or any failed vacuity check. A per-run JSON report goes to `tmp/qa/intelligence/scripted-evaluation.json` and a timestamped copy, with the exact settings (threshold file hash, answer key hash, targets), provider mode, counts, failures and the sentence that scripted results prove software behaviour only. The closing summary line counts targets from the run that matches the provider mode only (the live run in a live report, never the scripted key run added to it), and the reported provider mode is the one the disclosure gate decided. `tests/intelligenceEvaluation.test.ts` runs the same checks under `npm test`.

## Live evaluation: `npm run eval:intelligence -- --live`

Gated like `npm run eval:courtroom -- --live`. Nothing contacts a provider unless `--live` is on the command line, and it has not been run for this layer.

- The configured provider is used (`MODEL_PROVIDER`, `OPENAI_COMPATIBLE_*`). An external provider is refused before any request unless `EVAL_EXTERNAL_DISCLOSURE_CONFIRMED=1`. Use fictional fixtures only.
- Defaults come from the `live` block of the threshold file: 120 structured calls, 900,000 input characters, 900,000 ms elapsed, a 60 s request timeout and at most one retry. `EVAL_MAX_CALLS`, `EVAL_MAX_INPUT_CHARACTERS`, `EVAL_MAX_ELAPSED_MS`, `EVAL_REQUEST_TIMEOUT_MS` and `EVAL_MAX_RETRIES` may lower or, for the first four, change the budget explicitly; retries can never exceed the configured ceiling. HTTP requests, including retries, are counted by the same transport gate as the courtroom evaluation.
- A provider failure or exhausted budget is recorded as a failed step with its evidence. A scripted result is never substituted for a failed live one, and a missed target is reported as a failure, not tuned away.
- The key and degraded scripted runs and the invariants still run alongside it, so a live report always carries the proof that the scorer can fail. Provider failures are reported separately from the deterministic results.

A live result would show how one model performed on one small fictional packet. It would not show real-case validity, calibration, or legal correctness.
