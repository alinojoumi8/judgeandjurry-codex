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

## 2026-10-24 - Verify selected passages before diagnosing quotation layout

- **What went wrong:** A quote crossing numbered transcript lines was described
  as a normalization defect without first checking the checker’s selected
  paragraphs. The existing transcript comparison handled that layout; the
  supporting paragraph was omitted from the selection.
- **Correct approach:** Replay the whole attributed unit against its exact
  permitted projection and selectors. Verify whether the words exist in a
  selected passage before changing normalization. Locator candidates require
  fresh source/meaning review; they must not silently become accepted support.

## 2026-10-26 - Bind QA scope to the originating request

- **What went wrong:** The focused live-test transport inferred its actor from
  prompt text and blocked a legitimate independent coverage recheck whose
  reduced context deliberately omitted that actor label.
- **Correct approach:** Carry the originating structured stage and actor through
  asynchronous provider calls. Test narrowed checker/correction calls and denied
  later actors before a live run. Preserve the failed harness and its evidence;
  do not broaden model context or treat the stopped test as an acceptance pass.
