# Guided case workspace acceptance — 6 November 2026

## Scope

Implements TRL-29 on `codex/v1-case-workspace`, based on main
`b63d6ea6d98df0c069c2f847da8660318c949ac0`. The four destinations are
Overview, Documents, Simulation and Results. Advanced workflows remain
available. No API, database, provider, disclosure or source-validator contract
was changed. PR #10 is independent and remains draft.

## Behavior verified

- Multiple file uploads, source inspection and preserved-original download.
- Case-detail save failure retains the draft; retry succeeds. Switching areas
  preserves edits; leaving the case requires confirmation before discarding.
- Preparation and permission controls remain available before explicit generation.
- Failed/incomplete attempts do not display stale final decisions.
- Completed decisions use saved counts and participant-specific explanations.
  A split panel is labelled No unanimous decision only with twelve distinct,
  valid criminal final ballots.
- Source inspection preserves visible missing-passage and permission warnings.
  Desktop sources remain adjacent; phone sources use a focused dialog whose
  close/Escape returns focus to the initiating button.
- Archive download/import, saved case/run/view restoration and historical decision
  immutability after another upload.
- Desktop, 901px and 390px layouts. The independent reviewer found a compressed
  saved-attempt selector at 901px; the corrected selector now shows its attempt,
  completion state and date.

## Validation

All commands below completed successfully on the implementation before review.
The final core-check rerun and committed CodeRabbit/CI results are recorded in
its pull request.

| Command | Result |
| --- | --- |
| `npm run typecheck` | Passed independently of build |
| `npm run lint` | Passed; existing unnecessary-escape warning in server/grounding.ts |
| `npm test` | 4,452 passed, 1 conditional browser-coverage test skipped |
| `npm run build` | Passed |
| `npm run coverage:all` | 4,453 passed including browser coverage; 88.91% lines, 88.5% statements, 88.21% branches, 88.98% functions |
| `npm run test:ui` | Passed |
| `npm run test:sim` | Passed with scripted provider |
| `npm run test:arguments` | 23 acceptance checks passed; 449 scripted requests |
| `npm run test:courtroom` | Passed |
| `npm run eval:courtroom` | Scripted evaluation passed |
| `npm audit` | 0 vulnerabilities after compatible lockfile updates |
| `npm run check:authorities -- --strict` | Passed |
| `git diff --check` | Passed |

The conditional test in `tests/browserJourneys.test.ts` runs under
`RUN_BROWSER_COVERAGE=1` during aggregate coverage. It is not a missed browser gate.
The compatible lockfile updates cover body-parser, multer, mailparser/nodemailer,
qs, undici and zod; no package manifest or application API was changed.

## Design review

The Impeccable detector returned no findings. A fresh independent reviewer used
the skill's degraded reviewer contract because the packaged agent role was not
available. The reviewer validated all required captures and scored the 901px
selector correction resolved.

The numeric comparison against the illustrative concept remains **not passed**:
65.37% hero and 67.14% final, below the 72% threshold. Corrected captures and exact
region measurements replace the earlier invalid screenshot measurements. The
reviewer confirmed several legitimate adaptations: actual 9/3 saved votes instead
of illustrative 8/4, participant reasons instead of invented themes, actual TXT
source and missing-passage warnings instead of an illustrative PDF highlight,
and omission of the proposal-only banner. Source controls exist at a different
vertical position. These are recorded rather than hidden by changing fixture
results or suppressing warnings.

The user reviewed the rendered implementation and explicitly approved it on
6 November 2026: "Approve this design and merge after checks." The implementation
captures below are therefore the final visual authority. The original concept
and numeric failures remain historical evidence; they have not been relabelled
as passing. The independent reviewer subsequently scored both listed fixes resolved and returned disposition ship under that explicit approval. This is a verdict on the scored fixes, not a new whole-surface review. CodeRabbit and CI must still pass before merge.

CodeRabbit's first review of c19c9fd against b63d6ea raised two minor issues:
clean case details could remain stale after a server refresh, and a failed batch
upload did not name the failed file. Both received focused fixes and three
behavioral regressions, including dirty-draft preservation and retry of the
remaining files. The final committed review and check results are recorded in
the pull request.

## Evidence

All screenshots contain fictional test data. They are documentation assets,
not application imagery and not results from the user's OSC material.

- [Approved illustrative concept](case-workspace-2026-11-06/approved-concept.png)
- [Implemented desktop](case-workspace-2026-11-06/desktop-viewport.png)
- [Implemented phone](case-workspace-2026-11-06/mobile-viewport.png)
- [Phone source inspector](case-workspace-2026-11-06/mobile-source.png)
- [Corrected intermediate width](case-workspace-2026-11-06/user-901.png)

The concept was generated for the approved design proposal. Implementation
captures came from the local isolated browser fixture on 6 November 2026. The
fixture completed with 9 Guilty and 3 Not guilty final ballots and therefore no
unanimous decision. This is a deterministic UI demonstration, not a live jury
outcome or verdict probability.

## Remaining release work

This UI acceptance does not establish live-provider readiness or close the
independent validator/recovery issues in PR #10. No paid model run, real OSC
upload or new 126-page case acceptance was performed in this change. Recheck
those gates before declaring the private beta ready for case testing.