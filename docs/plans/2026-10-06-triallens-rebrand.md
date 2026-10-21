# TrialLens rebrand plan

Date: 2026-10-06<br>
Status: README and generated artwork delivered locally; application rebrand planned.

## Name and positioning

- Product name: **TrialLens** (capital T and L).
- Tagline: **See the evidence. Test the argument.**
- Description: A local AI workspace for exploring evidence, rehearsing courtroom arguments, and inspecting how a simulated decision was reached.
- Repository slug proposal: `triallens`. Keep the current repository and remote until a separate repository rename is requested.
- Avoid claims of predicted verdicts, guaranteed source accuracy, or legal certification. Describe implemented workflows and their limits.
- Name, trademark, and domain availability have not been checked.

## Scope and sequence

### Phase 1 — Repository front page and brand kit (delivered)

- [x] Rewrite the root README around the evidence-to-reasons journey.
- [x] Include a fictional-case walkthrough, setup, architecture, verification commands, and clear capability limits.
- [x] Generate a wide repository hero and matching square emblem with the built-in image generation tool.
- [x] Save the original operational README content in `docs/user-guide.md`, with relative links adjusted.
- [x] Record prompts, asset usage, and brand direction in `docs/brand/triallens/README.md`.

No application source, environment configuration, persisted data, or Git remote is changed by this phase. Existing checkout edits must remain intact.

### Phase 2 — Visible application identity

Inventory all visible branding before edits, separating labels from compatibility identifiers. Use the local source graph to locate symbols and trace callers before changing them.

| Surface | Known starting points | Planned change |
| --- | --- | --- |
| Browser tab and metadata | `index.html` | TrialLens title and accurate description |
| App shell and navigation | `src/App.tsx`, `src/App.css` | TrialLens wordmark; coherent product and workspace labels |
| Focused rehearsal workspace | `src/components/TrialForgeConsole.tsx` | Present as “Courtroom Rehearsal”; preserve component/type names initially |
| Favicon | `public/favicon.svg` | Create a simplified vector lens mark legible at 16/32 pixels |
| Generated rehearsal reports | `server/trialforge.ts`, `buildTrialForgeExport` | TrialLens report headings; assess downstream filename consumers before changing download suffixes |
| Other visible reports/messages | Graph search for old product strings | Review each occurrence; change human-facing copy only |
| UI journeys | `e2e/smoke.ts`, `e2e/arguments.ts`, `e2e/courtroom.ts` | Update only affected label assertions and screenshot expectations |

Use the generated emblem for larger tiles and the README brand kit. Do not shrink its detailed raster artwork directly into a favicon. Maintain readable type, keyboard focus, accessible names, and contrast. Capture before/after screenshots of the actual app using fictional data.

Acceptance:
- The browser title, shell, rehearsal headings, and newly generated report titles consistently say TrialLens.
- Existing matters, saved sessions, and archived imports still open.
- Navigation and test selectors work with the revised labels.
- No source or database rename is bundled into the visible identity change.

### Phase 3 — Documentation and developer metadata

- Update active setup and feature documentation to use TrialLens.
- Keep historical QA reports and immutable saved artifacts historically accurate; add context where needed instead of rewriting evidence.
- Consider changing the private npm package name to `triallens` in `package.json` and the matching root package-lock metadata. Verify that no scripts or tooling rely on the old package name.
- Audit example hosts, window titles, startup messages, and export documentation.
- Add actual fictional-data screenshots once the interface is rebranded. Label generated brand art separately.
- Retain links to the original terminology so existing users can find the renamed workflows.

### Phase 4 — Verification and release

Run the checks relevant to the changed application surfaces:

```sh
npm run lint
npm run typecheck
npm test
npm run build
npm run test:ui
npm run test:sim
npm run test:arguments
npm run test:courtroom
```

Inspect export headings and download names, favicon rendering, narrow and wide layouts, saved-run reopening, and archive round trips. Existing archive fixtures must retain their format identity and checksum validation. These checks need no new paid model evaluation for a presentation-only rebrand.

Release only after the relevant checks pass. A public repository rename, social-preview setting change, commit/push, or deployment is a separate action from this local documentation delivery. If requested, verify repository links and CI after publication.

## Compatibility contract

Keep these stable in the initial rebrand:

- `JUDGE_JURY_*` environment variables and their current meanings.
- `data/judge-jury.sqlite`, evidence/corpus locations, database schema and table names.
- The `judge-jury-matter` archive identifier and supported archive versions.
- Existing `/api/trialforge/*` routes, stored IDs, local-storage keys, serialized types, and protocol values.
- Historical transcript content, saved exports, immutable actor audits, and source hashes.
- Internal `TrialForge*` symbols unless a later refactor has a separate dependency and migration plan.

Changing a display name must not make the app appear empty, strand stored matters, invalidate an archive, or silently change model behavior. Internal consistency is less important than compatibility here.

## Rollback

The first delivery consists of documentation and new images. For a later application rollout, keep the presentation changes in a focused commit so they can be reverted without database rollback. Restore only the rebrand's changes; never reset the user's unrelated edits.

## Delivery validation

For this documentation phase: inspect both generated images, check all relative links and README anchors, verify referenced npm scripts and runtime requirements against package metadata, compare the preserved operational guide against the pre-edit README, and run whitespace checks. Application tests are deferred until application code changes.
