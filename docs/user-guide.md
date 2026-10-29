# TrialLens — Detailed workflow and operations guide

Local AI courtroom simulation and legal decision-support workspace.

This guide preserves the existing operational documentation during the TrialLens rebrand. The current app still displays Judge & Jury and TrialForge in places. Return to the [project overview](../README.md).

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
if (-not (Test-Path -LiteralPath .env.local)) {
    Copy-Item -LiteralPath .env.example -Destination .env.local
}
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

For external MiniMax calls, set `MODEL_PROVIDER=minimax` and provide `MINIMAX_API_KEY` in `.env.local`. The default model is `MiniMax-M3.1-Flash` and the default MiniMax base URL is `https://api.minimax.io/v1`. This is the GA model listed in the [official API guide](https://platform.minimax.io/docs/guides/text-generation). An explicit `MINIMAX_MODEL` value takes precedence, including existing preview-model configurations; setup does not rewrite an existing environment file.

Model calls use `MODEL_TIMEOUT_MS` and `MODEL_MAX_RETRIES` for timeout and retry/backoff control, `MODEL_MAX_OUTPUT_TOKENS` for the output budget (default 6,000 tokens on local runtimes and 16,000 on external providers, whose reasoning tokens share the budget), and `MODEL_TEMPERATURE` to override the per-stage sampling defaults.

When the API is bound to a non-loopback `HOST`, every route requires `LOCAL_API_TOKEN`, per-IP rate limiting is enabled (`API_RATE_LIMIT_PER_MINUTE`, default 240), and `TRUST_PROXY` should be set when a reverse proxy sits in front so the real client address is used. Loopback development is not rate-limited unless `API_RATE_LIMIT_PER_MINUTE` is set explicitly. Validation errors return 400 with the failing fields, missing records return 404, and runtime faults return a generic 500 whose details stay in the server log.

## Courtroom Realism

The **Courtroom protocol** option enables the new `courtroom_v1` path for an Ontario criminal jury Full Proceeding. It is opt-in while release review remains open. Use **Legal readiness** to prepare and attest a complete packet, save and approve the new case-model version, then start the proceeding. The run pins that packet; a material law change needs a new packet and run. Attestation records the reviewer and exact content hash and does not certify legal accuracy.

**Courtroom controls** manage witnesses, direct/cross/re-examination, objections, explicit judicial effects, jury absence/return and instructions. A paused examination or charge checkpoint requires the applicable command before resuming. **Participant memory** shows the selected actor's authorized record, instructions, assessments and open questions. Current exclusions and strikes affect future use while preserving the event history. Ballots must acknowledge the delivered instruction and explain a changed vote using a relevant visible event.

Document-use settings also accept permitted paragraph numbers, issue and party IDs, and prohibited purposes. Unknown or mismatched scope is withheld; original paragraph numbers survive projection. A reference cannot bypass these restrictions. Restriction meaning still needs semantic review. `npm run coverage:all` measures the isolated browser journeys alongside server tests and enforces 80% aggregate lines, statements, functions and branches. See the [release review worksheet](qa/courtroom-release-review.md) for independent behavioral and legal review.

Run `npm run test:courtroom` for the browser journey and `npm run eval:courtroom` for fictional scripted evaluations. Live evaluation is explicit (`npm run eval:courtroom -- --live`) and budgeted; see [evaluation details](evals/courtroom-realism.md). Coverage and dependency audit are current repository gates; check the candidate's CI results. The [release review worksheet](qa/courtroom-release-review.md) tracks independent behavioral and qualified legal review separately from mechanical checks and live source-verification acceptance.

The **Full Proceeding** workspace uses three separate procedure adapters: Ontario criminal jury, Ontario Capital Markets Tribunal, and Ontario civil (judge-alone or six-person jury). Procedure order and permitted moves are deterministic. Criminal guilt is decided only from twelve independent per-count ballots; OSC proceedings create no juror records; civil jury mode requires a valid jury notice and applies the five-of-six rule. Synthetic panels are not statistically representative and are not verdict predictions.

Full-proceeding actors all use the server's configured model provider, which is stamped onto each run as `config.provider` for the audit trail; clients cannot choose a provider per actor. The external-disclosure confirmation is required for screen and full runs alike whenever that provider is external (MiniMax), and is not required on a local OpenAI-compatible runtime such as Ollama. Motion rulings, objection rulings, and per-issue findings ask the model for the exact permitted disposition vocabulary and record the answer directly. Witness answers are generated in role but bounded to the witness's approved statement segments: an answer that does not cite an approved segment is replaced by the approved statement, and recall gaps are recorded as "do not recall". `deliberation.maxRounds` is the number of deliberation turns per juror (one inventory turn, one review turn, and the rest spent on challenges). Actor context roles are derived from the roster rather than taken from the caller.

Disclosure analysis scores heuristic hits: a single reported-speech phrase is a low-severity finding, while explicit hearsay language, repeated reported speech, privilege language, and extraction defects are motion-grade. The motion docket consolidates every motion-grade concern on the same exhibit into one proposed motion with the union of permitted relief. Deleting a matter releases its original uploads and any content-addressed corpus blobs that no other matter still references.

Full-proceeding jurors are seeded from continuous cognitive traits (comprehension, numeracy, memory, ambiguity tolerance, confidence calibration, narrative susceptibility, burden sensitivity, assertiveness, patience, and social influence). They are not assigned Crown/defence outcome quotas and no outcome is inferred from demographic stereotypes. Initial and final ballots are isolated per issue; invalid calls remain explicit no-verdict/incomplete records and cannot be filled in by a group response.

A final ballot compares its position only with one usable initial assessment for that actor and issue. A failed or unavailable initial ballot cannot create a change of mind. In both legacy and courtroom proceedings, an actual change requires an explicitly selected usable deliberation event, an explanation, and a shared permitted source; the engine never assigns the last speaker as its cause. Earlier saved runs retain their original records.

Source checks distinguish dollar suffixes from following section labels and recognize numbered continuation pages with an interview/transcript header. This affects quotation comparison only: original text, spoken numbers, speaker changes, citation offsets and saved quotations remain intact. Peer agreement and own-history clauses are checked separately; a source quotation following agreement is still checked against that source. Checker retries identify the eligible named-peer records and require a fresh successful judgment. Author repairs must keep each proposition with its own source and mark quotation omissions explicitly.

In **Neutral Case Model**, expand **Edit parties, counts and source coverage** to change parties, decision issues, elements, burdens and permitted outcomes, or import a prepared JSON model. Classify each source and identify whether the whole document or selected extracts were supplied. Record material outside the run as **Not supplied to this run** unless there is a separate basis for reporting a disclosure gap. Saving creates a new draft version; approve it before running. Existing proceedings keep their original model.

In **Admitted Record**, save document-use settings for every source. Limited sources require a permitted purpose, redacted sources require exact phrases, and sources can be hidden from particular roles. New sources start as reserved. These settings are simulation assumptions, not court rulings. The decision sheet shows the source coverage and document-use version for its saved run.

Full-proceeding model outputs receive a separate factual-source review before entering the public record or a ballot. The checker examines the draft against permitted source passages, including actors, amounts, payment direction, attribution and missing-record claims. It selects supporting paragraph identifiers; the server resolves those to exact saved source text and requires every draft unit to be reviewed. Any model-supplied quotations must also match the source. Checker formatting errors trigger a bounded checker retry; factual contradictions trigger an author repair attempt. Unverified output is withheld and its failure is recorded. **Factual source checks** shows quotations, regeneration attempts and withheld outputs, counting a failure and its placeholder once while preserving both events in history. Ballot placeholders show the actual failure reason. This review adds provider calls and can still miss semantic errors; it does not authenticate documents or certify legal analysis. Old runs without this audit remain labelled as not source-checked.

Each isolated juror request produces only that juror's current contribution or ballot, using their actual recorded prior assessments. The engine records the history; generated retrospective belief trails or simulated exchanges are rejected for regeneration. Complete explanations and citation endings are preserved for checking and storage. Where a response-length contract applies, an overlength draft is rejected rather than silently shortened. This applies to isolated jurors in both full-proceeding modes and does not enable the reviewed legal-packet protocol.

When a draft explicitly identifies an exhibit and quotes several passages, the server can complete an existing citation's coverage only if the exact words identify one permitted paragraph in that same exhibit. Altered words, ambiguous matches and unavailable passages remain failures. The checker receives the juror's current draft separately from their recorded history. A narrowly identified confusion between those two triggers a bounded recheck of the same draft; it does not make the draft pass. Claims of agreement with another juror require that juror's visible, usable contribution and its event reference. Audit field identifiers are not participant names.

The checker can select short references to visible contributions and procedural instructions; saved audits retain the exact original event IDs and words. The audit display shows these recorded references alongside document citations. Failed-turn placeholders cannot support peer attributions. A peer assessment can support an accurate account of that assessment, while an independent factual claim still needs source support. Approved exercise instructions remain distinct from verified operative charges and evidence admission. The final discussion review is also distinct from a saved final ballot. For consecutively numbered Q/A transcript blocks, quotation comparison recognizes printed line labels while retaining spoken numbers, speaker boundaries, original source text and paragraph offsets.

A mixed statement can cite both a document and an instruction: the document supports its factual clauses, and the instruction supports its procedural clauses. When replying to a juror, quotations explicitly attributed to a document are checked against that document; quotations attributed to the juror must match the saved contribution. An empty-history statement requires the author's explicitly empty supplied history. An unchanged-ballot explanation that discusses a peer must match both the author's usable initial/current choice and the cited peer contribution.

Inline citations after a sentence's period, including bare exhibit IDs, remain in an audit unit with their surrounding assertions, preserving the original word and citation order. The validator does not move that citation to the next assertion or guess which clause it supports. Explicit source prefixes such as “E-001 states” and prefixes on separate lines keep their own scope. Generated responses are asked to put citations before sentence-ending punctuation to avoid this ambiguity.

Quotation comparison tolerates capitalization changes while preserving the actual words, numbers, order and speaker boundaries; saved source quotations remain unchanged. Peer assessments still require the correct visible contribution and a successful review of every qualifier. A checker that confuses a bounded initial-history statement with global history, or rejects a peer-proof denial by repeating that same denial, can receive a bounded review of the unchanged draft. That retry grants no automatic acceptance. A negated proof assessment may mention a value threshold from the latest unambiguous supplied exercise instruction; the audit retains that instruction reference. It cannot supply a transaction amount or establish that the threshold was met.

An instruction-only statement of proposed exercise requirements can use the current instruction reference without a document quotation; the threshold and instruction scope must match. Named instruction, deliberation and submission IDs in generated speech must resolve uniquely to the corresponding visible record. Authors receive the actual reference choices, and fabricated IDs remain withheld even if the checker selected a different valid record. A checker that selects the wrong juror's reference receives a bounded retry only when the named juror has a usable visible contribution, including when its finding was already rejected. The checker must choose and verify the replacement. Current explanations of peer influence must match the author's present choice and remain distinct from claims of earlier events. Explicit stability or reinforcement of an initial position requires matching usable choice history. A statement that a peer supplied no evidence resolving the author's doubts is checked with that qualification intact; it does not establish that evidence is absent. Separate factual failures remain withheld throughout these checks.

Pure agreement with a peer's distinction and qualified explanations of that peer's influence require the actual visible contribution. Statements about the whole visible discussion require references covering every usable contribution; a selected subset cannot establish an absence across the discussion. A conditional statement about what could change the author's current view is kept separate from an assertion that such evidence exists. Matching current and initial choice history still governs claims of stability. Terminal exhibit labels do not turn a personal assessment into a source fact, but unavailable exhibit IDs remain invalid.

Checker findings identify their support domains: source passages, visible records, the author's own assessment, exercise instructions, supplied use restrictions, analysis, or whole-ballot coherence. Mixed findings must check every clause against its own support. These labels do not waive source, quotation, history, or permission checks. A coherence finding has no document or record citations; it compares the written position with the structured choice. Missing findings and invalid checker contracts receive bounded checks of the same draft, and exhausted contract repairs remain withheld without another author rewrite. If a provider or request-budget stop interrupts verification, the saved failure retains earlier findings, checker retries, and any applied patches. It never counts an unchecked patch as accepted.

New live checker responses use one required field for each supplied draft unit ID,
with explicit support domains and source/record selectors. Saved array-format
reviews remain readable. A successful non-source assessment uses the analysis
status; supported is reserved for source-backed claims. Missing or extra unit IDs,
missing fields and malformed selectors remain failures. Peer details must come
from that peer's actual contribution; additional exhibit facts belong in separate
source-attributed statements. An unusable initial ballot cannot establish that a
later position stayed unchanged.
An exact quoted peer doubt is checked against that peer's visible statement;
calling it a statement does not turn it into a document claim. Separate source
premises still need their own passages. A missing checker unit or a finding placed
outside the findings object receives a bounded format correction on the same draft,
including when another finding also rejects a substantive claim.
For MiniMax, a malformed checker contract uses the existing bounded retry to
request a flat array of complete findings through the tool channel. Each row
contains an explicit unit ID; duplicate IDs and incomplete rows are rejected
before the array is converted to the same strict keyed validation. The same
draft, source record and strict validation still apply. Misplaced findings and
invalid citation containers are identified in the correction feedback; exhausted
corrections remain withheld.
Reported investor reliance must be supported by the named source's selected
passages; describing an affiliation alone does not establish reliance. Disputed
quotations retain their actual speaker and the surrounding dispute. A checker
explanation may name a paragraph only when that exact locator is among its
verified source selections.
Checker corrections use complete valid row examples and identify the exact invalid selector entry. Explanations stay concise; paragraph numbers belong in structured citations. Exhausted JSON or paragraph corrections remain withheld.

Array corrections require an explicit unit ID on every finding. The system instructions, correction examples and tool schema use the same contract, presenting the ID before the judgment. Rows may arrive in any order, but missing, duplicate or unknown identities remain failures; neither array position nor a plausible quotation supplies an ID. The existing retry limit still applies.

Every same-draft MiniMax checker correction uses uniform findings, including semantic scope or paragraph rechecks after a structurally valid first review. Multi-unit corrections use a flat array with an explicit `unitId` on every row. A correction covering one unit takes one flat finding object: `unitId`, `recordCitations`, `citations`, `supportTypes`, `status`, and `explanation`. Record selection comes before the judgment: the checker must explicitly return `[]` when no visible record supports the claim. The tool description distinguishes an empty permitted-record inventory from visible records that require independent selection. Omissions remain failures; the app supplies no default arrays or reference IDs. The app converts only explicitly returned IDs and values for strict validation; it never reconstructs flattened findings or fills missing fields. Initial reviews retain their keyed contract. Empty reviews identify the required IDs, and missing-field feedback names the exact unit and field. Citation-array errors are reported only when those arrays or entries are actually invalid. The same draft and existing correction budget still apply.

When an explicit negative finding omits support metadata, the checker can complete its review on the same draft within the existing correction budget before an author repair. Completion cannot promote a substantive rejection on unchanged text to acceptance; mechanically identified checker scope errors retain their existing independent recheck path, and the original rejection and omitted fields remain in the audit. A remaining substantive rejection can still receive the existing bounded author repair. Empty reviews remain failures, and tool schemas require the exact finding inventory and support domains even for rejected claims.

An explicit rejection also remains in the audit when a malformed sibling row invalidates the overall checker schema. Only a unique supplied unit ID, its unchanged text, an explicit negative judgment and the actual explanation can anchor completion; missing support domains or references are never inferred. A newly reported rejection can correct an earlier false acceptance while its metadata is completed. A complete opposite judgment still requires an independent consistency recheck within the existing budget.

Advocates distinguish a document's author, a speaker quoted inside it and an opposing party's recorded submission. Reporting what the other party argued requires its actual visible, usable public submission. An affidavit, a private theory or a withheld contribution cannot supply that procedural claim. Accurately attributed source accounts and clearly hypothetical arguments remain available under their permitted purposes.

An unresolved question referring to an approved proposed-count value threshold can appear alongside source-backed analysis. Proposed captions can also retain a trailing party-name suffix. A burden statement that the Crown must prove every element of that proposed count beyond a reasonable doubt identifies the exercise requirement without asserting a transaction amount. The threshold is checked against the unique approved exercise element or current delivered instruction, rather than a source transaction. Quotations, actual-charge claims, reversed burdens and actual financial assertions retain their source requirements. Source money cannot authorize a different or missing exercise threshold, and this distinction does not establish an actual charge or a proved element.

When a quotation is attributed to correspondence reproduced in a report, matching words in the report narrative do not establish the correspondent's wording. The selected passages must contain an explicitly attributed quotation or a reproduced correspondence body with its actual sender. Only selected adjacent passages from the same exhibit can establish a continued body; unselected pages or a different sender cannot supply it. A report-author summary may instead be quoted as that report's summary. Attribution failures remain visible and can receive the existing bounded author repair, followed by an independent source check.

Every finding's `supportTypes` value must be a nonempty array of unique allowed strings, such as `["analysis"]`. System and user instructions, tool descriptions and correction feedback state the same shape. An object such as `{"analysis":""}` remains invalid; the app never converts its keys into accepted support domains. A correction must independently recheck the same draft within the existing retry limit, and persistent schema errors remain withheld.

An explicit unsupported or contradicted finding remains a rejection if it omits only its support-domain or record-reference fields. The audit preserves those omissions without inventing values, and the existing bounded author repair may address that rejected claim. Missing judgment, explanation or source-selector fields still stop the checker. Every potentially accepted finding requires complete metadata, and any repaired draft receives a fresh source check before acceptance.

Negative statements about document contents must stay within supplied excerpt coverage. Quoted source statements and assessments that evidence does not establish an element remain separate from assertions of document-wide absence. Source-backed numerical comparisons can refer to a threshold without asserting a transaction of exactly that amount; currency, inequality, source purpose and any issue instruction still apply.

A supplied-excerpt subject keeps that scope across coordinated clauses. For example, saying that the supplied excerpt lists a deposit but omits a repayment schedule does not describe omitted report pages. The checker must inspect all supplied text for the claimed omission. If it rejects a narrowly scoped statement solely by demanding whole-report coverage, the existing bounded retry can recheck the same draft; acceptance still requires a valid new review, and independent factual failures remain visible.

A statement about a supplied summary also remains limited to that summary. Mixed paragraphs may state source figures and separately describe a proposed value requirement. The requirement must match the unique approved exercise threshold, or the current unambiguous judicial instruction when one exists. Explicitly proposed exercise captions use the same check. These statements establish neither an actual charge nor a payment or loss; factual amounts still need their own source support, and quoted requirements remain source claims.

Quotation source selection keeps citation-group punctuation separate from prose boundaries. A local citation may follow the quote's explanatory phrase or sit immediately after sentence punctuation. Explicit source IDs still control; a later sentence or another quoted-source clause cannot supply a missing quotation source, and altered or wrong-source quotations remain rejected.

Adjacent reference groups such as `[E-006] [E-001]` form one local reference set. A quotation must match a verified selected passage within that set; a different selected document cannot rescue it. An explicit source ID in the quotation's introduction still takes precedence. When the words exist in another selected source but not the local source, the audit reports a quotation source mismatch rather than claiming that the words were altered. Repairs should put each quotation's own citation immediately after its clause.

Factual amounts receive the same check under supported and analysis classifications.
A standalone numerical comparison may choose a benchmark absent from the source;
it supplies no legal threshold, transaction, principal loss or proved element.
A rejected but independently verified standalone comparison receives a bounded
recheck of the same draft, requiring a valid fresh checker judgment. Before a
delivered instruction exists, approved exercise elements can supply the exercise
threshold. They are identified as scenario setup and create no judicial record.
Once an instruction exists, its actual current content controls.

A conditional reference to the approved numeric value element uses that same
current approval and currency. It does not assert a payment of that amount;
neighboring factual amounts still require their own source support.

After an author repair, a checker that changes an unchanged claim from accepted
to rejected, or the reverse, receives a bounded independent recheck. Prior
checker judgments are not evidence and cannot force acceptance. Two consistent
fresh reviews may correct an earlier judgment; unresolved disagreement remains
withheld with its audit history. Changed draft units are reviewed on their merits.

Unchanged claims carry their earlier source selectors into the checker as audit
targets while their text, source projection and permissions still match. Those
selectors supply no judgment or evidence. A narrowed selection requires an
independent review of the whole claim using only its current selected passages.
That review can resolve coverage alongside a separate failure without accepting
the failed claim or increasing the retry cap.

Preserved PDF previews use local decoder and font assets, including JPEG 2000
image decoding. A loaded image alone does not establish that a source page is
legible. The original file and its hash remain unchanged by preview rendering.

Responses marked truncated by the provider are withheld even when their partial JSON parses. Regeneration uses the existing retry and token limits and asks for a fresh, shorter complete object with exact references. Invalid checker JSON and misspelled citation fields can receive a bounded review of the same draft; no source is guessed from a misspelled field. Separate substantive rejections remain failures. Exhausted format repairs remain visible as failures.

Statements about a source's contents still require support when embedded in analysis, such as “its statement that no cash was returned supports inquiry.” The selected passage must support that premise; a nearby citation, another paragraph, or a conditional or denied statement cannot supply it. Trailing assessments such as “remains an allegation requiring proof” are separate from the reported fact. A statement about an affiliation does not by itself establish that the affiliation influenced an investment decision. Each clause must retain its own document, speaker and disputed status. The source check preserves genuine hypotheses and neutral questions.

Source repairs receive the actual rejected draft and request replacements by rejected unit ID. The server applies those replacements while retaining accepted text, titles, juror explanations and ballot metadata. Unknown, accepted or duplicate target IDs and extra patch fields are rejected atomically. The complete reconstructed response receives a fresh source check; a patch is never automatic acceptance. Applied replacements are retained in the audit. Legacy complete-response repairs still undergo the drift guard. A failed joint ballot-consistency check permits correction of its covered text and an explicitly listed structured choice target; identity and confidence remain fixed. Both legacy and courtroom-protocol ballots with an outcome contract receive this check. A no-verdict choice remains distinct from not guilty; the check does not prescribe an outcome.

Peer assessments use the named visible contribution, and stable-position statements require usable matching own history and the current choice. Procedural clauses use the current unique instruction, including structured element burdens. Claims about the entire visible discussion require all usable contributions. A source quotation or reported payment amount cannot borrow support from those records. Threshold comparisons in negative assessments remain tied to the supplied instruction. Paragraph citations following one sentence do not carry into a different document's quotation. Repairs include the selected peer words and source passages, and unsupported pronouns must use the supplied name or exact first-person quotation.

Source classification labels introduced by a document stay attributed to that document, even after a separate peer point. Named-peer checker candidates use the actual visible record table; a record number is not a juror number, and another juror cannot supply the named peer's words. Checker rows select references and support domains before the judgment, including rejected findings. An allowed candidate is not proof of its attributed claim, and missing fields still withhold acceptance. Quotation repairs must not insert slashes for transcript line breaks or introduce a new quotation to fix an unrelated premise; preserve actual words, use explicit ellipses for omissions, or write a faithful unquoted paraphrase. Every repair receives an independent check.

MiniMax source checks and source repairs use separate named tool-call output schemas with exact unit IDs. Repairs require the `replacement` field and omit the competing full-response schema from the prompt. These are output channels and execute no external action. Legacy text responses still receive the same complete JSON and source validation. Multiple or unknown tool calls, competing response content and malformed arguments are withheld; a malformed repair retains the original rejected draft's audit. Checker schema errors are retried on the same draft before author repair, even alongside a substantive rejection. Exhausted malformed checks do not trigger author regeneration. Retry errors remain in the saved audit, including when a later check succeeds; the interface distinguishes passed checks from exhausted failures.

Descriptive peer influence, such as an exhibit-by-exhibit assessment, is distinct from a ballot choice. Explicit stability still needs matching usable history. A recorded but unusable initial ballot does not provide a comparison; the current unverified draft is not a prior ballot. Proposed value thresholds are checked against the current unambiguous instruction, separately from amounts attributed to source documents. They do not establish an actual charge or transaction.

Checker repairs include an exact inventory of missing, unexpected and duplicate claim identifiers. An approximate identifier is never silently mapped to a different claim. Source-use notes remain application context: saying a document itself warns or cautions requires caution or qualification language in its cited passages and a successful meaning review. Category definitions alone do not supply a source warning; an author's interpretation should be stated separately.

The selected workspace, workflow step and saved proceeding reopen after reload. Use **Saved proceeding** to switch runs or **Resume saved proceeding** for a failed or ready run. The full-proceeding banner reports that run's saved model, panel and external-disclosure confirmation.

Before starting, **Check source size** previews the largest permitted source context against the 240,000-character limit and lists its largest source contributions. Starting a new proceeding repeats this check on the server. An oversized record is blocked before a run or provider request is created. In **Admitted Record**, select documents or permitted paragraph numbers and save a new document-use version; original files and paragraph locators remain intact. Start a new proceeding with that version. Existing runs keep their pinned record. This preview covers selected sources; later arguments and testimony also consume context, so a passing preview cannot guarantee that a long proceeding will fit.

In the neutral model editor, **Element evidence matrix** maps exact extracted passages to supporting, contrary or disputed evidence for each element, with open questions. The server checks the passage against this matter's source text and supplies the saved quotation. These are user preparation annotations. Save and approve a new model version before starting a new proceeding.

On **Decision Sheet**, expand **Evidence and reasons** to inspect the saved element mappings, use restrictions, unresolved questions and recorded ballot explanations. Source links open the saved quotation with surrounding extracted passages, extraction warnings and the original file's SHA-256; preserved PDFs can be viewed at a page when the extraction records that location. Download the preserved original to verify other file formats. Completed decisions retain their trace when later models or document-use settings change; earlier decisions without a trace remain explicitly labelled.

The **Robustness Lab** can reuse the baseline's starting record or select another saved document-use version. Each comparison shows starting and final use differences, seeds, recorded outcomes and changed ballot choices. Counts include completed runs only. These comparisons show association with changed inputs and rulings; they do not establish causation or real verdict probabilities.

PDF intake also attempts local OCR for sparse text layers, including scanned pages with only a readable page number. OCR-derived text and unresolved sparse pages carry review warnings in the source record and model context. Verify significant wording and table layout against the preserved original images.

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

Matter archives use the versioned `judge-jury-matter` JSON format. Version 3 is used for matters containing `courtroom_v1` runs and includes courtroom state, command receipts and original serialized actor requests; legacy-only matters continue exporting version 2. Both preserve source blobs by SHA-256, corpus manifests, derived OCR/transcripts, approved case models, theories, disclosure findings, motions/rulings, admission ledgers, trial events, actor snapshots, ballots, decision sheets, and provider audit metadata. Import verifies the archive checksum and every blob hash, creates collision-safe IDs, and rewrites current internal references while retaining execution provenance. Version 1 imports remain supported and receive empty v2 workflow collections; unsupported future versions fail closed.

- `GET /api/matters/:matterId/archive` exports a matter archive.
- `POST /api/matters/import` imports a matter archive.
- `POST /api/system/backup` creates a consistent SQLite backup under `data/backups/` using SQLite's online backup API.

Database changes are applied transactionally and tracked with SQLite `PRAGMA user_version`, currently 8 (v3 corpus, v4 case/motion/admission workflow, v5 event engine, v6 courtroom records, v7 evidence scopes, v8 preview hashes). Keep `data/judge-jury.sqlite`, `data/evidence/`, and `data/corpus/blobs/` together during manual recovery. See [Recovery and archive compatibility](recovery-and-archives.md).

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
npm run test:arguments
npm run check:authorities
```

The Playwright smoke test starts the local API and Vite client, verifies the empty no-demo workspace, exercises TrialForge exhibit and authority drill-downs, completes and reopens a saved rehearsal, and checks that only Local and External provider modes are exposed. It does not run a live model simulation unless a real provider is configured separately.

`npm run test:sim` runs a full simulation end to end against a scripted OpenAI-compatible provider (no real model needed): it verifies the realistic stage order, the twelve independent secret-ballot calls, per-stage sampling temperatures, hung-jury calibration, and the exported report.

`npm run test:arguments` exercises the Full Proceeding browser workflow with the [fictional Crown and defence packet](../samples/criminal-fraud/README.md), editable parties/counts/source coverage, versioned document-use restrictions, separate private theories, disclosure review, a judicial-instructions checkpoint, twelve initial and final ballots, archive export, three robustness variants, and restored decisions after reload. It uses deterministic injected actors and an isolated temporary database. Reports, screenshots, and the fictional archive are saved in `tmp/qa/arguments/`. UI defects make this command exit with status 1. This regression test does not assess live model quality or validate legal conclusions; private live-case tests use separate ignored artifacts.
