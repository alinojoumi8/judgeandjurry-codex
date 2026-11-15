# Case intelligence M0 baseline - 8 November 2026

## Scope

This is the starting point for the work in
[the case intelligence plan](../plans/2026-11-08-case-intelligence-features.plan.md).
It shows which checks pass before that work changes anything.

- Commit: `origin/main` at `e75b41eaeee776b361408175bd76e396922c437e`, checked out
  on `feature/case-intelligence-m0`.
- Tree: unmodified. `git status --short` listed nothing before or after the run.
- Machine: Windows 11, Node.js v24.15.0, npm 11.12.1, after a fresh `npm ci`.
- Run: 14:21 to 14:36 Toronto time, one command at a time, in the order used by
  `.github/workflows/ci.yml` at that commit.
- Models: no live provider calls. This worktree has no `.env.local`.
- Port 5173 was already in use by another process during the run.

## Results

| Command | Result | Time | Detail |
| --- | --- | --- | --- |
| `npm ci` | Passed | 88 s | 430 packages added; 0 vulnerabilities |
| `npm run typecheck` | Passed | 12 s | Standalone `tsc -b` |
| `npm run lint` | Passed | 1 s | One warning: `server/grounding.ts:370:58`, `no-useless-escape` |
| `npm test` | **Failed** | 379 s | 2 failed, 4,453 passed, 1 skipped |
| `npm run build` | Passed | 13 s | |
| `npm run coverage:all` | Passed | 306 s | 4,456 of 4,456 tests passed, including `tests/pdfCoverage.test.ts` |
| `npm run test:ui` | Passed | 6 s | Exit 0; the script prints no per-check lines |
| `npm run test:sim` | Passed | 3 s | Scripted provider |
| `npm run test:arguments` | **Failed** | 46 s | 21 of 23 checks passed, then a timeout |
| `npm run test:courtroom` | Passed | 13 s | |
| `npm run eval:courtroom` | Passed | 25 s | Scripted evaluation only |
| `npm audit` | Passed | 1 s | 0 vulnerabilities |
| `npm run check:authorities -- --strict` | Passed | 10 s | Link reachability only; does not validate any legal proposition |

## The two failures

Neither failure was fixed in this work. A later pass does not replace the failed
results above.

`npm test`: both failures are in `tests/pdfCoverage.test.ts`, and both are
`Test timed out in 5000ms`. The affected tests are "OCRs a page containing only a
footer and exposes the OCR warning on its evidence item" and "preserves the native
text and warns when OCR adds no readable body". Vitest also reported a timeout
terminating the worker for that file.

`npm run test:arguments`: the journey stopped at `e2e/arguments.ts:455`, waiting
15 seconds for "No unanimous decision" after importing a downloaded archive and
selecting Attempt 1. The saved page still showed a later attempt's unanimous
not-guilty decision, with "Working…" visible. This may be a race between loading
the imported case and selecting a saved attempt. That cause has not been
confirmed.

| Follow-up, same commit and unmodified tree | Result |
| --- | --- |
| `npx vitest run tests/pdfCoverage.test.ts`, run once in isolation | 2 of 2 passed in 1.17 s |
| `npm run test:arguments`, run once more | 23 of 23 checks passed; exit 0 |
| GitHub Actions for this commit, read with `gh run list`, not run here | Reported success |

Both failures therefore look intermittent on this machine. One clean re-run does
not prove that. A later failure in either place is not automatically caused by new
work, and it is not automatically a false alarm.

## After the fixture was added

The same list ran again from 14:51 to 15:03 Toronto time, on the same commit. The
only additions were this record, the plan, `samples/civil-negligence/` and
`tests/civilNegligenceFixture.test.ts`. No application code changed.

| Command | Result | Time | Detail |
| --- | --- | --- | --- |
| `npm run typecheck` | Passed | 14 s | |
| `npm run lint` | Passed | 1 s | The same single warning as the baseline |
| `npm test` | Passed | 241 s | 4,465 passed, 1 skipped, including the 10 new fixture tests |
| `npm run build` | Passed | 13 s | |
| `npm run coverage:all` | Passed | 344 s | 4,466 of 4,466 tests passed |
| `npm run test:ui` | Passed | 6 s | |
| `npm run test:sim` | Passed | 3 s | |
| `npm run test:arguments` | **Failed** | 32 s | 22 of 23 checks passed |
| `npm run test:courtroom` | Passed | 13 s | |
| `npm run eval:courtroom` | Passed | 24 s | |
| `npm audit` | Passed | 2 s | 0 vulnerabilities |
| `npm run check:authorities -- --strict` | Passed | 9 s | Link reachability only |

The `test:arguments` failure this time was the final check, at
`e2e/arguments.ts:457`: the journey recorded a `502` for `/api/trials/<id>`. The
journey's Vite proxy logged `connect ETIMEDOUT` when it tried to reach the test
API. Three more runs all passed 23 of 23: once alone, once straight after
`npm run test:sim`, and once alone again.

Across this commit, `test:arguments` failed in 2 of 6 runs. Both failures came
during the full list, and both came at the end of the journey, around reopening an
imported archive. The first happened before anything was added. The cause has not
been found, and this work did not try to fix it.

The new fixture test was also checked against nine deliberate breakages: a changed
quoted line, a removed injection line, totals that no longer add up, a stated
qualification or `CV` file number in the report meant to have neither, a treatment
entry inside the records gap, a record event citing a pleading, a wrong paragraph
number, and the canary in the README. The focused test failed for each one. It
passed with Windows line endings on every fixture file.

CodeRabbit has not reviewed this work. `coderabbit auth status --agent` reported
`not_authenticated`.

## What this does not establish

These checks use scripted actors and fictional fixtures. They establish software
behaviour under those fixtures. They do not establish live model quality, legal
correctness, or integration with any external system.
