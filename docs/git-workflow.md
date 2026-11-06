# Commit, push and branch routine

Use this routine at the start of a task, at each coherent tested milestone,
before changing tasks, and when handing work back. Its purpose is to keep useful
work recoverable and make the next Git action explicit.

## Establish the current state

Run each command separately from the intended checkout:

```powershell
git status --short
git branch --show-current
git worktree list
git fetch --prune origin
git branch -vv
```

Check the actual remote URL and GitHub PR head/base before publishing or judging
readiness. If an upstream exists, this reports upstream-only commits first and
local-only commits second:

```powershell
git rev-list --left-right --count '@{upstream}...HEAD'
```

A missing upstream is a branch configuration state: inspect the intended remote
branch, then configure tracking or create the branch as appropriate. A failed
fetch leaves remote commit state unverified. An unavailable GitHub check leaves
validation status unknown; retry or confirm it before claiming readiness.
Check all worktrees before deleting a branch. Preserve dirty or detached
worktrees and existing stashes.

## Recommend the next action

| Observed state | Recommendation |
| --- | --- |
| A coherent task-owned change is implemented and checked | Commit the named files now, before starting another change. |
| Local-only commits exist and the upstream-only count is zero | Review the outgoing commits for private data, then push to that branch after applicable checks. |
| The upstream-only count is greater than zero, including divergence | Reconcile first using an authorized fast-forward, merge or rebase as appropriate. Preserve dirty work and avoid rewriting shared history; do not force-push to hide divergence. |
| A feature branch has no upstream | Confirm the destination and create its own GitHub branch with `git push -u origin HEAD`. |
| Work needs review or still has failing/unfinished acceptance checks | Push an appropriate checkpoint only within authorization; keep its PR draft and record the exact blockers. |
| Current-head checks and CodeRabbit pass, and the requested behavior is complete | Recommend merging the PR into main; use existing merge authorization or request it. |
| A branch's work is already integrated and no open PR/worktree depends on it | Recommend deletion locally and on GitHub; execute when cleanup is authorized. |

Do not turn this table into automatic commits, pushes or merges. Act on the
user's current authorization, and do not ask again for an action already
authorized. For long unfinished tasks, suggest a clear checkpoint at a stable
boundary; state failing or unrun checks honestly. A push preserves commits on
GitHub; it does not certify readiness for main.

## Make a focused checkpoint

1. Review the exact diff and name the files belonging to this task. Do not use
   `git add .` or `git add -A`. Exclude secrets, real evidence, databases, private
   captures and runtime logs; include required fictional fixtures.
2. Run the checks required by `AGENTS.md`, including build, tests, lint and a
   standalone typecheck for documentation changes. Run the complete applicable
   CI/browser/evaluation gates. Preserve failures and report their actual scope.
3. Commit only the selected files with a focused conventional commit message.
   `git commit -- <paths>` takes each named file's current contents, not only its
   staged hunks. Use it only when every change in those files belongs to this
   task, after reviewing both staged and unstaged diffs. If a file mixes task
   changes with unrelated or private edits, prepare only the intended changes
   in a clean worktree first. Naming paths excludes staged files at other paths.
4. Recheck the branch, destination, PR and upstream-only count immediately before
   pushing. If GitHub has commits absent locally, reconcile first within the
   current authorization. For a new branch, verify the intended remote branch
   does not already exist. Use the branch's intended remote; for this repository
   it is normally `origin`.
   Push the feature branch, never an unreviewed update directly to main.
5. Create or update the appropriate PR within authorization. Keep it draft until
   the behavior, current-head validation and completed CodeRabbit review meet
   the project requirements. Record the reviewed base/head and issue decisions.

Large dirty legacy checkouts need reconciliation first. Compare against the
current reviewed main and active feature branch, separate already integrated
files from genuinely new work, and inspect unpublished history before pushing.
Do not publish old private evaluation history just to eliminate an ahead count.
Use a clean checkout based on current main for selected publishable changes.

## Remove finished branches safely

After fetching, verify the exact local and remote tips. An ancestor of the
current main is integrated. A squash/rebuilt branch needs stronger proof: an
identical Git tree at a commit contained in main, or a reviewed comparison that
accounts for every change. A closed PR or an old date alone is insufficient.

Record branch names, tip SHAs and the proof before deletion. Preserve a local
recoverable bundle when removing rewritten history. Check for open dependent
PRs and active worktrees; never remove a dirty worktree to make deletion pass.
An idle clean worktree can switch branches or detach at its existing commit.

Delete only the specifically approved finished branches. Recheck remote tips
immediately before deletion and guard against concurrent changes. Verify the
remaining local and GitHub refs afterward. Do not publish backup bundles or
private audit data.

## Final handoff

Include a short Git checkpoint in every substantive handoff:

- Branch and checkout when multiple worktrees exist.
- Task commit SHA, whether it is pushed, and any remaining task-owned changes.
- PR URL and current validation/review state; distinguish evidence read from CI
  from commands run locally in this task.
- Next action: commit, push, continue the draft, request merge, or clean up.

If no checkpoint was made, explain the concrete blocker and identify the work
that remains local. Never label a branch ready for main solely from its name,
age, clean status or a historical test report.
