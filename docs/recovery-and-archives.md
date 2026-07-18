# Recovery and Archive Compatibility

Judge & Jury stores operational state in SQLite and original corpus bytes in immutable, content-addressed storage. A reliable recovery needs both.

## Supported formats

- Database schema `PRAGMA user_version = 5` is current.
- Matter archive format version 2 is current.
- Archive version 1 remains importable. Its legacy matter, evidence, simulation, juror, and TrialForge records are preserved; new v2 workflow collections start empty.
- Future database or archive versions fail closed rather than being partially interpreted.

Archive compatibility is additive within format version 2. Required fields and SHA-256 validation will not be weakened. A breaking representation change requires a new archive version and an explicit importer.

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

## Corpus jobs after restart

Jobs left `queued`, `running`, or `paused` are re-opened from SQLite. Already completed manifest entries are not reprocessed. The source path or preserved ZIP must still be available until the job finishes; completed entries remain backed by content-addressed blobs.

Password-protected files are never assigned stored passwords. They remain `locked` and must be reprocessed from a new approved preview when credentials or converted sources become available.
