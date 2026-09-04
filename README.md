# Judge & Jury

Local AI courtroom simulation and legal decision-support workspace.

## What It Does

- Creates local matters with pasted case narratives and Ontario/Canada jurisdiction defaults.
- Uploads evidence files, preserves the originals with SHA-256 provenance, and assigns immutable exhibit IDs like `E-001`.
- Accepts uploads up to 250MB by default, using disk-backed temp files instead of memory buffering.
- Runs structured courtroom rounds in realistic order: intake, issue spotting, Crown/plaintiff opening (the burden-bearer presents first), defence response, Crown reply, defence closing, the judge's charge to the jury, jury deliberation, and judge synthesis.
- Runs Ontario courtroom rehearsals in TrialForge, preserving every transcript, letting users reopen earlier sessions, and linking transcript citations to exhibit details and transparently labelled curated legal-authority sources.
- Tracks every simulation stage durably so failed runs can resume from the first incomplete stage, and recovers sessions orphaned by a server restart.
- Searches locally extracted evidence chunks so agents receive targeted exhibit context before each stage.
- Stores matters, evidence provenance and extracted text, turns, jury opinions, and verdict reports in local SQLite, with versioned migrations and consistent backups.
- Uses a real local OpenAI-compatible provider by default, such as Ollama, and can be explicitly configured for external MiniMax calls.
- Adds a Trial Engine v2 guided workflow: recursive folder/ZIP intake, neutral case-model approval, private competing theories, disclosure review, approved motions, versioned admission rulings, full proceedings, per-issue decisions, and scenario robustness runs.

This is decision-support software only. It is not legal advice and does not produce binding court outcomes.

## Run Locally

```powershell
npm install
Copy-Item .env.example .env.local
npm run dev
```

Open `http://127.0.0.1:5173`.

For a local OpenAI-compatible runtime, set:

```powershell
MODEL_PROVIDER=openai-compatible
OPENAI_COMPATIBLE_BASE_URL=http://localhost:11434/v1
OPENAI_COMPATIBLE_API_KEY=ollama
OPENAI_COMPATIBLE_MODEL=qwen2.5:14b
```

For external MiniMax calls, set `MODEL_PROVIDER=minimax` and provide `MINIMAX_API_KEY` in `.env.local`. The default model is `MiniMax-M3` and the default MiniMax base URL is `https://api.minimax.io/v1`.

Model calls use `MODEL_TIMEOUT_MS` and `MODEL_MAX_RETRIES` for timeout and retry/backoff control, `MODEL_MAX_OUTPUT_TOKENS` for the output budget (default 6,000 tokens on local runtimes and 16,000 on external providers, whose reasoning tokens share the budget), and `MODEL_TEMPERATURE` to override the per-stage sampling defaults.

When the API is bound to a non-loopback `HOST`, every route requires `LOCAL_API_TOKEN`, per-IP rate limiting is enabled (`API_RATE_LIMIT_PER_MINUTE`, default 240), and `TRUST_PROXY` should be set when a reverse proxy sits in front so the real client address is used. Loopback development is not rate-limited unless `API_RATE_LIMIT_PER_MINUTE` is set explicitly. Validation errors return 400 with the failing fields, missing records return 404, and runtime faults return a generic 500 whose details stay in the server log.

## Courtroom Realism

The **Full Proceeding** workspace uses three separate procedure adapters: Ontario criminal jury, Ontario Capital Markets Tribunal, and Ontario civil (judge-alone or six-person jury). Procedure order and permitted moves are deterministic. Criminal guilt is decided only from twelve independent per-count ballots; OSC proceedings create no juror records; civil jury mode requires a valid jury notice and applies the five-of-six rule. Synthetic panels are not statistically representative and are not verdict predictions.

Full-proceeding actors all use the server's configured model provider, which is stamped onto each run as `config.provider` for the audit trail; clients cannot choose a provider per actor. The external-disclosure confirmation is required for screen and full runs alike whenever that provider is external (MiniMax), and is not required on a local OpenAI-compatible runtime such as Ollama. Motion rulings, objection rulings, and per-issue findings ask the model for the exact permitted disposition vocabulary and record the answer directly. Witness answers are generated in role but bounded to the witness's approved statement segments: an answer that does not cite an approved segment is replaced by the approved statement, and recall gaps are recorded as "do not recall". `deliberation.maxRounds` is the number of deliberation turns per juror (one inventory turn, one review turn, and the rest spent on challenges). Actor context roles are derived from the roster rather than taken from the caller.

Disclosure analysis scores heuristic hits: a single reported-speech phrase is a low-severity finding, while explicit hearsay language, repeated reported speech, privilege language, and extraction defects are motion-grade. The motion docket consolidates every motion-grade concern on the same exhibit into one proposed motion with the union of permitted relief. Deleting a matter releases its original uploads and any content-addressed corpus blobs that no other matter still references.

Full-proceeding jurors are seeded from continuous cognitive traits (comprehension, numeracy, memory, ambiguity tolerance, confidence calibration, narrative susceptibility, burden sensitivity, assertiveness, patience, and social influence). They are not assigned Crown/defence outcome quotas and no outcome is inferred from demographic stereotypes. Initial and final ballots are isolated per issue; invalid calls remain explicit no-verdict/incomplete records and cannot be filled in by a group response.

The paragraphs below describe the preserved **legacy fast simulation** workflow and its saved sessions.

Every simulation creates a fresh, session-stable jury pool from varied persona archetypes. Saved sessions keep their original jurors, but new runs sample a different balanced panel with distinct roles, skepticism levels, burden sensitivity, default leanings, and evidence focuses.

Panel size and the decision rule follow the real forum for each template:

- **Criminal Defence** - 12 jurors, unanimity required; anything less is treated as a hung jury.
- **Civil Dispute** - 6 jurors, agreement of at least 5 of 6 required (Ontario civil jury majority).
- **OSC / Securities** - a 3-member tribunal-style panel that decides by simple majority.

By default the jury deliberates in **independent secret-ballot mode**: each juror casts an independent ballot in its own model call (with retrieval personalized to that juror's evidence focus) before the panel deliberates together, so opinions are not generated in one correlated pass. The ballot is recorded as the first `secret_ballot` snapshot in each juror's belief trail, and a final vote that departs from the ballot without a deliberation-based explanation is flagged. Switch to the faster single-pass mode in Run Settings if you prefer one model call for the whole panel.

Before deliberation the judge delivers a charge to the jury (elements, burden and standard of proof, credibility and circumstantial-evidence guidance, and the decision rule), and the jury is instructed to apply it. Sampling temperature also varies by role: jurors deliberate at higher temperature for natural diversity, advocates argue at a middle setting, and the analyst, charge, and synthesis stages stay near-deterministic. Override with `MODEL_TEMPERATURE`.

The judge stage receives the structured jury deliberation record, including the split, the decision rule, the verdict status, and individual juror rationales, and is instructed to use realistic outcome language for the template (guilty/not guilty/hung jury; liable/not liable; allegations proven/not proven). Verdict confidence is calibrated from the model's ruling, jury consensus, the decision rule, juror confidence, citation warnings, and unresolved issues. High confidence near 90% is reserved for panels that actually met their decision rule with clean citations and limited proof gaps; a hung panel is capped and explicitly reported as unresolved.

## Logs

The app writes structured JSONL logs under `logs/` by default:

- `logs/app-YYYY-MM-DD.jsonl` has startup, request, upload, extraction, MiniMax, simulation, SSE, and browser-submitted client events.
- `logs/error-YYYY-MM-DD.jsonl` contains only error-level entries for faster triage.
- Every API request receives an `x-request-id`; the same ID is written to request, route, and error logs.

The logger records IDs, timings, statuses, file metadata, extracted character counts, provider status, and stack traces. It redacts sensitive fields such as API keys, tokens, prompts, narratives, packet text, and evidence text. Configure with `LOG_DIR`, `LOG_LEVEL`, and `LOG_ENABLED` in `.env.local`.

## Upload Limit

The default upload limit is 250MB. Change it with `JUDGE_JURY_MAX_UPLOAD_BYTES` in `.env.local`; temporary upload files are written under `UPLOAD_TMP_DIR` and removed after extraction. Originals are retained under `EVIDENCE_STORAGE_DIR`, hashed with SHA-256, and remain downloadable even when text extraction fails. Archiving an exhibit hides it from active work without deleting the source or reusing its exhibit number.

## Archives, Recovery, and Database Upgrades

Matter archives use the versioned `judge-jury-matter` JSON format. Format version 2 deduplicates preserved source blobs by SHA-256 and includes corpus manifests, derived OCR/transcripts, approved case models, theories, disclosure findings, motions/rulings, admission ledgers, trial events, actor snapshots, ballots, decision sheets, and provider audit metadata. Import verifies the archive checksum and every blob hash, creates collision-safe IDs, and rewrites internal references. Version 1 imports remain supported and receive empty v2 workflow collections; unsupported future versions fail closed.

- `GET /api/matters/:matterId/archive` exports a matter archive.
- `POST /api/matters/import` imports a matter archive.
- `POST /api/system/backup` creates a consistent SQLite backup under `data/backups/` using SQLite's online backup API.

Database changes are applied transactionally and tracked with SQLite `PRAGMA user_version` (v3 corpus, v4 case/motion/admission workflow, v5 event engine). Keep `data/judge-jury.sqlite`, `data/evidence/`, and `data/corpus/blobs/` together during manual recovery. See [Recovery and archive compatibility](docs/recovery-and-archives.md).

## Local and Remote API Safety

The default `HOST=127.0.0.1` mode is loopback-only and does not require authentication. A non-loopback `HOST` fails at startup unless `LOCAL_API_TOKEN` contains at least 24 characters and `ALLOWED_ORIGINS` contains explicit comma-separated origins. In remote mode every API and SSE request requires `Authorization: Bearer <LOCAL_API_TOKEN>`. Requests are rate-limited in memory; configure the per-client ceiling with `API_RATE_LIMIT_PER_MINUTE`.

The built-in browser client is intended for loopback mode. Put remote deployments behind a TLS reverse proxy that injects the bearer token and does not log it.

TrialForge authorities are a curated local registry, not a live citator. The UI exposes provenance and source notes, unknown model-generated IDs are suppressed, and `npm run check:authorities` checks whether curated source links remain reachable without claiming substantive legal validation.

## Verification

```powershell
npm run lint
npm run typecheck
npm test
npm run build
npm run test:ui
npm run test:sim
npm run check:authorities
```

The Playwright smoke test starts the local API and Vite client, verifies the empty no-demo workspace, exercises TrialForge exhibit and authority drill-downs, completes and reopens a saved rehearsal, and checks that only Local and External provider modes are exposed. It does not run a live model simulation unless a real provider is configured separately.

`npm run test:sim` runs a full simulation end to end against a scripted OpenAI-compatible provider (no real model needed): it verifies the realistic stage order, the twelve independent secret-ballot calls, per-stage sampling temperatures, hung-jury calibration, and the exported report.
