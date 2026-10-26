# Project lessons

Read this file before starting a task. Keep entries short and actionable.

## 2026-10-15 - Preserve requested contributor rules

- **What went wrong:** The first AGENTS.md adaptation condensed the supplied hard
  and important rules, weakened approval and verification requirements, and
  omitted the explicit correction log. A documentation-only testing exemption
  was added without the user requesting it.
- **Correct approach:** Preserve the user's requested rule headings and meaning.
  Adapt project-specific commands and tool names without silently dropping or
  weakening rules. Check for conflicting guidance elsewhere in the file, apply
  user corrections first, and record the lesson here. The requested build, test,
  lint, and typecheck requirement also applies to documentation-only tasks.

## 2026-10-26 - Finish each task with a Git checkpoint

- **What went wrong:** Work accumulated as local edits, unpublished commits and
  completed branches, making the active checkout and GitHub readiness unclear.
- **Correct approach:** Verify branch/worktree/upstream state, recommend a
  focused commit after each tested unit and a push for local-only commits only
  when no upstream commits are missing locally. Reconcile divergence first and
  act when already authorized. Report draft PR blockers explicitly. Verify
  integration before deleting finished branches and preserve private history.
