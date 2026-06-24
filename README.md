# Judge & Jury

Local AI courtroom simulation and legal decision-support workspace.

## What It Does

- Creates local matters with pasted case narratives and Ontario/Canada jurisdiction defaults.
- Uploads evidence files and assigns exhibit IDs like `E-001`.
- Accepts uploads up to 250MB by default, using disk-backed temp files instead of memory buffering.
- Runs structured courtroom rounds: intake, issue spotting, defence, Crown, rebuttals, jury opinions, and judge synthesis.
- Tracks every simulation stage durably so failed runs can resume from the first incomplete stage.
- Searches locally extracted evidence chunks so agents receive targeted exhibit context before each stage.
- Stores matters, evidence summaries, turns, jury opinions, and verdict reports in local SQLite.
- Uses MiniMax by default, supports deterministic mock mode, and can point at a local OpenAI-compatible endpoint such as Ollama.

This is decision-support software only. It is not legal advice and does not produce binding court outcomes.

## Run Locally

```powershell
npm install
Copy-Item .env.example .env.local
npm run dev
```

Open `http://127.0.0.1:5173`.

For live MiniMax calls, set `MINIMAX_API_KEY` in `.env.local` and change `MINIMAX_MOCK=0`. The default model is `MiniMax-M3` and the default MiniMax base URL is `https://api.minimax.io/v1`.

For a local OpenAI-compatible runtime, set:

```powershell
MODEL_PROVIDER=openai-compatible
OPENAI_COMPATIBLE_BASE_URL=http://localhost:11434/v1
OPENAI_COMPATIBLE_API_KEY=ollama
OPENAI_COMPATIBLE_MODEL=qwen2.5:14b
MINIMAX_MOCK=0
```

Model calls use `MODEL_TIMEOUT_MS` and `MODEL_MAX_RETRIES` for timeout and retry/backoff control.

## Logs

The app writes structured JSONL logs under `logs/` by default:

- `logs/app-YYYY-MM-DD.jsonl` has startup, request, upload, extraction, MiniMax, simulation, SSE, and browser-submitted client events.
- `logs/error-YYYY-MM-DD.jsonl` contains only error-level entries for faster triage.
- Every API request receives an `x-request-id`; the same ID is written to request, route, and error logs.

The logger records IDs, timings, statuses, file metadata, extracted character counts, provider status, and stack traces. It redacts sensitive fields such as API keys, tokens, prompts, narratives, packet text, and evidence text. Configure with `LOG_DIR`, `LOG_LEVEL`, and `LOG_ENABLED` in `.env.local`.

## Upload Limit

The default upload limit is 250MB. Change it with `JUDGE_JURY_MAX_UPLOAD_BYTES` in `.env.local`; temporary upload files are written under `UPLOAD_TMP_DIR` and removed after extraction.

## Verification

```powershell
npm run lint
npm run typecheck
npm test
npm run build
npm run test:ui
```

The Playwright smoke test starts the local API and Vite client with `MINIMAX_MOCK=1`, runs a simulation, and verifies that the timeline and verdict summary render.
