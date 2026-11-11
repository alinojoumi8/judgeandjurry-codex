# Recovery and Archive Compatibility

Judge & Jury stores operational state in SQLite and original corpus bytes in immutable, content-addressed storage. A reliable recovery needs both.

## Supported formats

- Database schema `PRAGMA user_version = 14` is current. Migration 14 adds three nullable columns to `issue_ballots` (`element_findings_json`, `amounts_json`, `apportionment_json`) for ballot contract v2 (see Ballot contract v2 and juror cognition below); no table was added. Migration 13 adds `venue_datasets`, the research datasets a matter imported for its local jury profile (see Venue datasets and the jury profile below). Migration 12 adds `matter_frameworks` and `framework_attestations`, the court rules a matter has chosen and lawyer attestations (see Court rules below). Migration 11 adds `analysis_jobs`, the operational record of analysis jobs (see Analysis jobs below). Migration 10 adds `analysis_artifacts`, the versioned private store for analysis results (see Analysis artifacts below). Migration 6 adds courtroom state, command receipts, immutable actor inputs and ballot instruction references; migration 7 persists evidence scopes; migration 8 persists preview hashes independently of preserved source-blob hashes; migration 9 adds a private evidence note column. Notes remain outside evidence/model projections and are preserved in matter archives; older archives default to an empty note.
- Matter archive format version 6 is written only when the matter has imported venue datasets. Version 5 is written when it has chosen court rules but no datasets. Version 4 is written when it has analysis artifacts but no chosen court rules. Otherwise version 3 is used for `courtroom_v1` runs and legacy-only matters continue exporting version 2, with no analysis or court-rules key.
- Archive version 1 remains importable. Its legacy matter, evidence, simulation, juror, and TrialForge records are preserved; new v2 workflow collections start empty.
- Future database or archive versions fail closed rather than being partially interpreted.

Versions 1, 2, 3, 4, 5 and 6 have explicit import paths. Protocol runs require the courtroom collections (v3, v4, v5 and v6); presenting them as v2 fails closed, and a v4 or v5 archive with a protocol run but without the courtroom collections is refused. Required fields and SHA-256 validation are not weakened.

Version 3 includes courtroom state, command receipts and original serialized actor requests. Imported current references and derived memory hashes are remapped/rebuilt. Original execution input bytes and hashes are retained with import provenance rather than relabelled as newly executed requests. Owner audit access is separate from participant context; an audit may contain preparation that a juror is not allowed to receive. Recovery reconstructs authorized participant context from events and current restrictions instead of trusting cached snapshot text.

## Analysis artifacts

`analysis_artifacts` holds versioned analysis results, each pinned to an input manifest (evidence hashes, case-model version, ledger and run ids). Saved content, rejected items and manifest are never rewritten; only the status changes (draft, approved, superseded, failed). Each row records a SHA-256 over canonical JSON of its content, rejected items and manifest, and every read verifies it. A row whose content no longer matches its hash, or whose schema version is newer than this build supports, is refused with an error naming the artifact.

Archive format 4 carries these rows as the last snapshot collection. Import validates each row (known kind, status, audience and schema version) and verifies its hash against the exported JSON before anything is written, so a tampered row is refused even when the envelope checksum was recomputed. References to evidence, case models, ledgers and runs inside the JSON are then remapped to the new ids, the hash is recomputed from the remapped JSON, and `import_provenance_json` records the original artifact id and hash. Approval state is preserved. Party ids in `subject_key` are not remapped. Ids must appear only as JSON values, never as object keys, because remapping walks values only.

Whether an artifact is still current is shown from its manifest (out of date or not) and is never regenerated automatically. Artifacts are owner preparation material: they are not given to simulated jurors or witnesses.

## Court rules

Rule packs are data kept in the repository (`server/frameworks/packs/`), not in the database. What the database stores is the matter's choice (`matter_frameworks`: one row per matter with the pack id, the hash of the effective rules, its matter-level overrides and an append-only history of who changed what and when) and attestations (`framework_attestations`: a named reviewer, the pack id and the exact pack hash they reviewed). Both keep their JSON in `_json` columns.

**The pinned framework travels with the run.** A civil run created while the matter has chosen court rules stores the resolved rules (panel size, threshold, reduced-panel rule, judge-only kinds, the pack hash, the base pack hash, every override and the review state at that moment) inside the run's `config_json` as `framework`. It is already part of the run row, so no separate column is needed and no earlier run changes. A run created with no chosen rules has no `framework` key and behaves exactly as before. The server pins the framework; a `framework` sent by a client is discarded. A variant of an earlier run (a robustness variant) keeps its parent's pinned framework even if the matter's rules changed since.

**Archive format 5** adds `matterFrameworks` as the last snapshot collection, after `analysisArtifacts`, which is optional in version 5. Import checks, before anything is written, that each row names a pack this build has, that its overrides are valid and still apply to that pack, and that every run's pinned framework still parses; a row or run that fails is refused even when the envelope checksum was recomputed. A pack that changed since the row was saved is not refused. The view then reports `packChangedSinceSaved`. Ids are remapped like any other row. **Attestations are not part of a matter archive.** They are about a pack hash, not a matter, and live only in the database; a backup of the SQLite file includes them. A run's pinned framework records whether it was reviewed when it was pinned, so an imported run keeps what it said then.

**Review.** A pack shows as reviewed only while an attestation exists for the pack id whose hash equals the hash of the pack as it is now. Editing any rule (a pack edit or a matter override) changes the hash, so the attestation stops matching. Review fields written into a pack's own data are ignored. Packs ship with no attestation. Recording one is deliberately not a screen or an API route (anyone using the app could otherwise approve their own rules); a qualified reviewer's attestation is inserted with `store.frameworks.addAttestation({ packId, packHash, reviewerName, reviewedAt })` against the hash shown by `GET /api/frameworks`. Decision D7 (who reviews) is still open.

## Venue datasets and the jury profile

Imported datasets (population tables, attitude surveys, focus-group findings and verdict observations) are private research inputs. They are **stored per matter**, not globally, so that a matter archive carries the exact data its jury profile was built from and the profile can still be checked after a restore or import. Each row carries its source and licence; every dataset has a retrieval date and a content hash over its kind, source, date, licence and rows (not its display name). Datasets are immutable once imported; identical data is kept once per matter.

**Archive format 6** adds `venueDatasets` as the last snapshot collection, after `matterFrameworks`; `analysisArtifacts` and `matterFrameworks` are optional in version 6 and the collection must not be empty. Import checks, before anything is written, that each row has a known kind, that every stored row still parses, carries a source and licence, and that the rows still hash to the recorded dataset hash; a changed row is refused even when the envelope checksum was recomputed. A run's pinned jury profile (`juryProfile` in `config_json`) must still parse. A `jury_profile` artifact contains no ids (datasets are named by content hash and row id), so its content hash is unchanged by an import and a run pinned to it can still be matched.

**Deleting a dataset** is refused (HTTP 409) while an approved profile was built from it. A draft profile does not protect its datasets; deleting one marks the draft out of date, and a draft whose data is gone cannot be approved. **Approval rebuilds the profile** from its recorded datasets, assumptions, seed and eligibility snapshot and refuses it unless every figure reproduces, so no figure can enter a profile except through a dataset row.

## Ballot contract v2 and juror cognition

Both are per-run opt-ins pinned in the run's `config_json` as `ballotContract: "v2"` and `jurorCognition: true`. A run that did not opt in has neither key, and its rows, events and prompts are exactly what they were before; no earlier run changes.

**No new archive format and no new collection.** Ballot v2 data lives in three nullable `_json` columns on `issue_ballots`, which already travels in every format. Juror appraisals (`juror_appraisal` and `juror_appraisal_failed`) and the derived roles (`jury_roles_derived`) are trial events, visible only to the named juror and the system (roles: the system only), so they travel in `trialEvents` and are remapped like any other event; an appraisal's `momentEventId` is remapped to the imported event. Straw polls would be trial events too: the two-value `round` check on `issue_ballots` is unchanged.

Export keeps older archives byte-for-byte: a ballot with no v2 fields exports without the three columns (a null column is left out), so a matter that never used v2 exports exactly as before and an older build can still import it. A matter that used v2 exports rows that carry the columns; an older build refuses them because its table has no such columns.

Import fails closed before anything is written, even when the envelope checksum was recomputed: a v2 column that does not parse as the shape this build writes, a run whose `ballotContract` is anything but `"v2"`, or whose `jurorCognition` is anything but `true`, is refused. Source references inside element findings are remapped to the imported evidence. Appraisal text is simulated model output and is archived as such; it is owner audit material that a juror never receives.

## Deliberation forecast

A per-run opt-in pinned in the run's `config_json` as `deliberationForecast: true` and `strawPollCounts: "visible"` or `"hidden"` (the server writes the second whenever the first is on). A run that did not opt in has neither key and none of the events below, and its rows, events and prompts are exactly what they were before; no earlier run changes. A golden regression test (`tests/ballotCognitionRegression.test.ts`) holds this.

**No new archive format, no new collection and no migration.** The forecast's records are plain JSON trial events, so they travel in `trialEvents` and are remapped like any other event: `deliberation_round_planned` (speaking order and turns per juror, system only), `straw_poll_ballot_recorded` (one juror's private vote, visible to that juror and the system, with `changedByEventId`), `deliberation_straw_poll` (the counts, visible to the jurors and the system only when `strawPollCounts` is `visible`, otherwise to the system only) and the existing `juror_deliberation_turn`, which gains `stance`, `replyToEventId`, `replyToActorId`, `slot` and `structureProblems`. `replyToEventId` and `changedByEventId` are remapped to the imported events. A straw-poll vote is never a ballot, so `issue_ballots` and its two-value `round` check are unchanged.

Import fails closed before anything is written, even when the envelope checksum was recomputed: a run whose `deliberationForecast` is anything but `true`, or whose `strawPollCounts` is anything but `visible` or `hidden` (or is present without the forecast), is refused. The event text and the stances are simulated model output and are archived as such; they are owner audit material that a juror never receives beyond what the run showed in the room (the counts, when visible).

Analysis (camps, friction, holdouts, who moved whom, the vote path and the table across runs) is computed on read from these records and the saved ballots and decision sheet; nothing is stored, so there is nothing to recompute after a restore. It names the algorithm version it used (`deliberation-analysis-v1`; the speaking-order plan is `deliberation-plan-v1`).

## Damages and psychology

No new archive format, collection or migration. Damages inputs and studies are `damages_model` analysis artifacts (subjects `inputs` and `study`) and psychology studies are `damages_psychology` artifacts, so they travel in archive format 4's `analysisArtifacts` with the existing hash checks and run-id remapping (artifact content holds category ids only as values, never as keys). The damages run settings are pinned in the run's `config_json`: `damagesAmounts: true`, the pinned `damagesCategories`, `damagesExcluded`, `damagesCurrency`, and `damagesCondition` (the condition id and the finished text). A run that did not opt in has none of these keys. Import fails closed, even when the envelope checksum was recomputed, on a run whose `damagesAmounts` is anything but `true`, or whose `damagesCondition` has no known id or has no `damagesAmounts`. The `damagesCategories` rule was added to the rule pack schema, which changes every pack hash: a saved court-rule choice shows "the rule pack has changed since you chose it" until it is saved again, and earlier runs keep the framework they pinned. Per-run amounts are computed on read from the saved ballots (`amounts_json`); nothing about them is stored separately.

## Advocacy style studies

No new archive format, collection or migration. Style studies are `style_study` analysis artifacts (owner audience, subject ""), so they travel in archive format 4's `analysisArtifacts` with the existing hash checks and run-id remapping; the artifact content holds run ids and party ids only as values, never as keys. The run setting is pinned in the run's `config_json` as `advocacy`: a list of `{ partyId, id, catalogueVersion, text }` (the party, the catalogue id, the catalogue version and the exact text the party's counsel was given), so a restored run records what its advocate was told even if the catalogue later changes. Party ids inside it are values and are remapped on import. A run that did not opt in has no `advocacy` key. Import fails closed, even when the envelope checksum was recomputed, on a run whose `advocacy` is not a non-empty list of entries with a party id, a style id this version's catalogue knows and a text. A non-public `advocacy_style_applied` trial event records that a style was used; it is visible to the owner and the system only, and it travels with the run's other events.

## Analysis jobs

`analysis_jobs` records queued, running and finished analysis jobs: parameters, cost estimate, cap, usage, the ids of artifacts a job produced, and its status. Jobs are operational records, not matter data. **They are not part of a matter archive** and are not restored from one; only the analysis artifacts a job produced are archived, with the matter. A backup of the SQLite file includes jobs. Deleting a matter deletes its jobs.

Nothing survives a restart in memory. When the server starts, jobs left `running` or `queued` are set to `interrupted`, with their usage and partial results kept, and can be resumed. A job can be resumed only from `interrupted`, `stopped_at_cap` or `failed`.

## Back up

Use `POST /api/system/backup`. It uses SQLite's online backup API, so the snapshot is consistent even if the application is processing writes. Do not copy an open SQLite database directly.

For a complete filesystem recovery, retain these together:

- `data/judge-jury.sqlite`
- `data/evidence/` for originals uploaded through the legacy evidence intake
- `data/corpus/blobs/` for recursively imported folder/ZIP originals

Matter archives are portable recovery units for individual matters. Version 2 embeds every referenced blob once and verifies both the envelope checksum and each blob checksum during import.

## Restore

1. Stop the application.
2. Preserve the current `data/` directory as a rollback copy.
3. Restore the SQLite backup and the matching evidence/blob directories.
4. Start the application. Ordered migrations run inside transactions.
5. Verify `/api/health`, open representative source downloads, and compare displayed SHA-256 values.
6. Export and re-import a representative matter archive before resuming substantive work.

If a migration fails, its transaction is rolled back and `user_version` is not advanced. Keep the pre-restore copy until hashes, event histories, ballots, and decision sheets have been inspected.

The Full Proceeding workspace restores its selected run and step from browser-local preferences, then loads the model, briefs, admission ledger, decisions and audit from SQLite. On a new browser it selects the latest saved run; the Saved proceeding menu can reopen another. A failed or ready run can be resumed from its saved phase. Preferences are not the record of a verdict: clearing browser storage does not delete the persisted run.

When the application starts, proceeding runs left `running` by an interrupted
process become `failed` with an interruption explanation and can be resumed
explicitly. Startup preserves their saved phase, events, ballots and audit history;
it does not dispatch new model requests. Ready, checkpoint, failed and completed
runs retain their existing state. Opening a store only for backup, import or audit
does not perform this startup recovery. Run one application owner per store.

Source coverage and factual-check audits are additive JSON fields within archive version 2. Earlier models may have unclassified coverage and earlier events may have no source-check audit; the UI displays those limitations rather than treating the old outputs as verified.

Element evidence matrices are stored in the versioned model JSON. New decision sheets embed an immutable evidence trace in their decision JSON, including the original model/ledger references, saved passage quotations and ballot explanations. These additive fields need no SQLite migration or archive-version change. Import remaps embedded source, model, ledger, event and ballot IDs alongside the corresponding rows. Older decision sheets have no trace and are displayed without inventing one. Starting admission-ledger IDs are recorded in new run-created events for scenario comparison; older runs may lack that starting record.

## Corpus jobs after restart

Preview hashes are retained in `preview_sha256`, which is independent of the blob foreign key. Before importing a hashed source, the engine checks its bytes against that preview hash. Older queued jobs can recover the expected hash from their saved preview. Changed or disappeared sources produce failed manifest entries instead of substitute evidence. Large ZIP entries whose preview hash was explicitly deferred still carry that limitation.

Jobs left `queued`, `running`, or `paused` are re-opened from SQLite. Already completed manifest entries are not reprocessed. The source path or preserved ZIP must still be available until the job finishes; completed entries remain backed by content-addressed blobs.

Password-protected files are never assigned stored passwords. They remain `locked` and must be reprocessed from a new approved preview when credentials or converted sources become available.
