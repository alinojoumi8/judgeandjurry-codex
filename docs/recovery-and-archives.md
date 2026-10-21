# Recovery and Archive Compatibility

Judge & Jury stores operational state in SQLite and original corpus bytes in immutable, content-addressed storage. A reliable recovery needs both.

## Supported formats

- Database schema `PRAGMA user_version = 8` is current. Migration 6 adds courtroom state, command receipts, immutable actor inputs and ballot instruction references; migration 7 persists evidence scopes; migration 8 persists preview hashes independently of preserved source-blob hashes.
- Matter archive format version 3 is used for `courtroom_v1` runs; legacy-only matters continue exporting version 2.
- Archive version 1 remains importable. Its legacy matter, evidence, simulation, juror, and TrialForge records are preserved; new v2 workflow collections start empty.
- Future database or archive versions fail closed rather than being partially interpreted.

Versions 1, 2 and 3 have explicit import paths. Protocol runs require v3 courtroom collections; presenting them as v2 fails closed. Required fields and SHA-256 validation are not weakened.

Version 3 includes courtroom state, command receipts and original serialized actor requests. Imported current references and derived memory hashes are remapped/rebuilt. Original execution input bytes and hashes are retained with import provenance rather than relabelled as newly executed requests. Owner audit access is separate from participant context; an audit may contain preparation that a juror is not allowed to receive. Recovery reconstructs authorized participant context from events and current restrictions instead of trusting cached snapshot text.

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
