# Courtroom evaluation

The opt-in `courtroom_v1` protocol is evaluated separately from the legacy proceeding. Fixtures contain fictional people, sources, private briefs and authorities. They are software tests, not legal authority or evidence about a real case. The manifest is `samples/courtroom-realism/manifest.json`.

## Deterministic checks

Run `npm run eval:courtroom` for ten scenarios with three attempts each. The runner uses the actual engine with an explicitly injected scripted model. It checks authorized actor context, restriction and strike propagation, jury absence, question replacement, instruction gates, missing evidence and completion. It records request hashes, failures and budget use in `tmp/qa/courtroom/scripted-evaluation.json`. A successful scripted response does not demonstrate that a live model can reason correctly.

Run `npm run test:courtroom` for the isolated browser journey. It exercises sustained objections, replacement questions, direct/cross/re-examination, jury return, limiting instructions, the charge checkpoint, completion, reload and role privacy. Existing browser scripts should be run serially because parallel runs can interfere with timing.

The scripted budget is 2,500 actor requests, 100 million input characters and 120 seconds. These are resource caps, not an invitation to spend on a provider. The fixture requires no provider calls.

## Live pilot

Run `npm run eval:courtroom -- --live` against the configured provider. Defaults cap the pilot at eight HTTP requests, 120,000 input characters and 45 seconds, with a 15-second request timeout. `EVAL_MAX_CALLS`, `EVAL_MAX_INPUT_CHARACTERS`, `EVAL_MAX_ELAPSED_MS` and `EVAL_REQUEST_TIMEOUT_MS` permit explicit budget changes. External providers require `EVAL_EXTERNAL_DISCLOSURE_CONFIRMED`; use fictional fixtures only.

The transport counts real HTTP requests, including grounding and repair attempts. Provider token usage is summed when available; null means unknown. Monetary cost remains unknown. The runner saves failure evidence and stops when the budget or source verification prevents further progress. It never substitutes a scripted result for a failed live result. pass^3 is unavailable until three attempts exist. Repair defaults to at most one attempt; `EVAL_MAX_RETRIES=0` disables it. Reports preserve failed model audits and are also saved to timestamped filenames.

`--opening-pilot` explicitly stops at the evidence checkpoint and does not test examination or juror decisions. `--full-suite` selects all ten manifest scenarios instead of the default two-case pilot. All modes preserve unexecuted scenario IDs; these are not passes. Request timeouts are capped by `MODEL_TIMEOUT_MS` as well as `EVAL_REQUEST_TIMEOUT_MS`.

The October 3 pilot with local `qwen2.5:7b` stopped after the first opening failed source verification: two HTTP calls, 4,039 reported tokens, approximately 46 seconds. The configured 14B model was absent; the initial connection failure and a separate 7B timeout were preserved. No model was downloaded, no persistent provider setting was changed, and the loaded 7B model was unloaded after testing.

## Independent review still required

Human grading must inspect factual attribution, witness scope, fair treatment of contrary evidence, permissible use of limited evidence, legal elements and burdens, instruction comprehension, and reasons for changed votes. Review paired fixtures without rewarding a preferred verdict. Passage, issue, party, purpose and exact-reference permissions now have mechanical checks; their semantic interpretation still requires independent review. Unknown scope withholds scoped evidence. The [release worksheet](../qa/courtroom-release-review.md) records the required review.

Qualified review of current applicable authorities is required for a real legal packet. A reviewer attestation is bound to its content hash; it is not an independent certification. Fixture reports therefore keep `releaseReady: false`. The complete successful live suite and human rubric adjudication remain unresolved. The ECC follow-up now meets all four aggregate 80% coverage thresholds; see [verification](../qa/courtroom-hardening.md) for exact results and current live-provider evidence.
