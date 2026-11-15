---
name: TrialLens
description: A restrained case workspace for reading preserved sources and reviewing simulated decisions.
colors:
  case-accent: '#7a0f2a'
  case-accent-hover: '#5f0b20'
  case-accent-soft: '#f3e9ed'
  case-ink: '#202027'
  case-muted: '#5e5e69'
  case-border: '#dedee4'
  case-surface: '#fafafb'
  paper: '#ffffff'
  control-border: '#b6b6c0'
  input-border: '#b9b9c4'
  outcome-surface: '#faf5f7'
  warning-text: '#765017'
  warning-surface: '#fff7e8'
  focus: '#966a09'
  selected-passage: '#fff0cd'
  selected-passage-border: '#c4a462'
  complete-text: '#236049'
  save-error: '#9c2727'
typography:
  headline:
    fontFamily: Inter, "Segoe UI", Roboto, Helvetica, Arial, sans-serif
    fontSize: 28px
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: -.02em
  title:
    fontFamily: Inter, "Segoe UI", Roboto, Helvetica, Arial, sans-serif
    fontSize: 23px
    fontWeight: 700
    lineHeight: 1.25
  section:
    fontFamily: Inter, "Segoe UI", Roboto, Helvetica, Arial, sans-serif
    fontSize: 17px
    fontWeight: 700
  outcome:
    fontFamily: Inter, "Segoe UI", Roboto, Helvetica, Arial, sans-serif
    fontSize: 29px
    fontWeight: 700
    lineHeight: 1.2
  body:
    fontFamily: Inter, "Segoe UI", Roboto, Helvetica, Arial, sans-serif
    fontSize: 15px
    lineHeight: 1.5
  passage:
    fontFamily: Inter, "Segoe UI", Roboto, Helvetica, Arial, sans-serif
    fontSize: 15px
    lineHeight: 1.65
  control:
    fontFamily: Inter, "Segoe UI", Roboto, Helvetica, Arial, sans-serif
    fontSize: 14px
    lineHeight: 1.4
  support:
    fontFamily: Inter, "Segoe UI", Roboto, Helvetica, Arial, sans-serif
    fontSize: 13px
  metadata:
    fontFamily: Inter, "Segoe UI", Roboto, Helvetica, Arial, sans-serif
    fontSize: 12px
rounded:
  passage: 4px
  notice: 5px
  control: 6px
  outcome: 8px
  upload: 10px
spacing:
  '6': 6px
  '8': 8px
  '12': 12px
  '16': 16px
  '18': 18px
  '20': 20px
  '24': 24px
  '28': 28px
  '32': 32px
  '48': 48px
components:
  button-primary:
    backgroundColor: '{colors.case-accent}'
    textColor: '{colors.paper}'
    rounded: '{rounded.control}'
    padding: 8px 13px
    typography: '{typography.control}'
  button-primary-hover:
    backgroundColor: '{colors.case-accent-hover}'
  button-secondary:
    backgroundColor: '{colors.paper}'
    textColor: '{colors.case-ink}'
    rounded: '{rounded.control}'
    padding: 8px 13px
    typography: '{typography.control}'
  button-secondary-hover:
    backgroundColor: '{colors.case-surface}'
  input:
    backgroundColor: '{colors.paper}'
    textColor: '{colors.case-ink}'
    rounded: '{rounded.control}'
    padding: 10px 12px
  navigation-item:
    backgroundColor: transparent
    textColor: '{colors.case-ink}'
    rounded: '{rounded.control}'
    padding: 12px 10px
  navigation-item-selected:
    backgroundColor: '{colors.case-accent-soft}'
    textColor: '{colors.case-accent}'
  source-reference:
    backgroundColor: '{colors.case-accent-soft}'
    textColor: '{colors.case-accent}'
    rounded: '{rounded.control}'
    padding: 8px 13px
    typography: '{typography.control}'
  outcome-summary:
    backgroundColor: '{colors.outcome-surface}'
    textColor: '{colors.case-ink}'
    rounded: '{rounded.outcome}'
    padding: 24px
  warning:
    backgroundColor: '{colors.warning-surface}'
    textColor: '{colors.warning-text}'
    rounded: '{rounded.notice}'
    padding: 12px
    typography: '{typography.support}'
  source-passage:
    backgroundColor: '{colors.case-surface}'
    textColor: '{colors.case-ink}'
    rounded: '{rounded.passage}'
    padding: 15px
    typography: '{typography.passage}'
  source-passage-selected:
    backgroundColor: '{colors.selected-passage}'
  source-inspector:
    backgroundColor: '{colors.paper}'
    textColor: '{colors.case-ink}'
    padding: 28px 24px
---

# Design System: TrialLens

## Overview

**Creative North Star: "The Case Workspace"**

The case workspace uses white reading surfaces, ink text, burgundy actions, and quiet gray dividers. One sans-serif stack keeps navigation, explanations, and preserved source passages in the same visual language. The existing TrialLens mark remains the identity asset.

The visual hierarchy supports close reading: restrained panels identify outcomes and warnings, while source references stay beside the explanations that cite them. Status words and saved-state feedback remain visible. The design does not turn a synthetic outcome into a prediction or a source reference into a finding of truth.

**Key Characteristics:**
- Burgundy primary actions and selected destinations on white and pale gray surfaces.
- Compact controls with generous reading space and wrapping source text.
- Flat containers, light borders, and tonal emphasis instead of decorative shadows.
- Visible warnings, keyboard focus, and an explicit Save action.

This records the implemented guided case workspace. Evidence: [caseWorkspace.css](src/caseWorkspace.css), [index.css](src/index.css), and the inherited base rules in [App.css](src/App.css). The cascade loads index, App, then case workspace. The approved composition remains in the [surface brief](.impeccable/surfaces/src-app-tsx.md). Historical advanced-tool styles are not a new visual authority. This document records implementation; it does not certify the separate design acceptance gate.

## Colors

Burgundy provides the identity accent; white, pale gray, and ink carry most of the reading surface. The frontmatter is the normative value list.

### Primary

- **Case burgundy:** primary actions, current navigation, source-reference text, and the outcome heading.
- **Deep burgundy:** the primary action's hover state.
- **Pale burgundy:** selected destinations and source-reference backgrounds.

### Neutral

- **Case ink / muted ink:** body text, controls, explanatory copy, and provenance.
- **Paper / reading surface:** the main workspace and quiet inset passages.
- **Quiet divider:** rail boundaries and horizontal separators.
- **Control and input strokes:** actionable controls and editable fields.
- **Outcome wash:** the recorded outcome summary.

### Semantic support

Warning amber uses warning-text on warning-surface. Selected source passages use selected-passage with selected-passage-border. Complete-text marks completed status, save-error marks a failed save, and focus supplies the keyboard outline. These colors communicate state rather than adding brand accents.

**The Meaningful Accent Rule.** Use burgundy for primary actions, the current destination, and source references. Keep warnings and completion states in their observed semantic colors.

## Typography

**Display and body family:** the single inherited sans-serif stack in the frontmatter. No separate display face is introduced. The stack starts with Inter and retains the existing platform fallbacks; this document adds no font asset.

The hierarchy is compact and direct. Weight and spacing establish structure while source text remains easy to read.

### Hierarchy

- **Headline:** the case-view heading; reduces to 25px on narrow screens, and 23px in narrow Results.
- **Title / section:** guided section headings and smaller reason groups.
- **Outcome:** the recorded outcome heading; narrow Results uses 25px.
- **Body / passage:** shared reading size, with the passage role's more open line height.
- **Control:** buttons and source actions.
- **Support / metadata:** explanatory copy and provenance, never the main preserved passage.

The side source heading is 21px with a 1.25 line height. Main paragraphs are capped at 75ch. Ballot counts use tabular numbers.

**The Reading Rhythm Rule.** Keep source passages at the body size with the more open passage line height; do not compress them to metadata size.

## Layout

The desktop shell has a 232px case rail and a flexible main region. The header has an 80px minimum height; the main reading panel uses 30px 32px 48px padding. When a source opens, the main region splits into a flexible reason column and a source column with a 350px minimum and 39% preferred share.

At 1150px and below, the rail narrows to 200px, main padding becomes 26px 22px 40px, and an open source takes 350px. Results tools stop floating beside the saved-attempt selector, which can use the full available width. At 900px and below, the rail becomes a top navigation region and the source inspector becomes a full-screen modal. At 540px and below, navigation icons sit above labels and main padding becomes 24px 16px 36px.

Use the extracted spacing steps for repeated gaps and section separation. Document and reason lists use horizontal dividers rather than enclosing every row in a card. Forms have a 760px maximum width; source and case text can wrap. These dimensions describe this workspace rather than prescribing every future product surface.

## Elevation & Depth

The guided workspace is flat. The outcome wash, source-passage wash, thin separators, and spacing establish depth. The source inspector sits beside the reason on desktop and uses a translucent ink backdrop in its narrow-screen modal form. There is no guided-workspace shadow vocabulary.

**The Flat Reading Surface Rule.** Separate the case rail, result, and source with borders, spacing, and pale surfaces. The guided workspace adds no decorative box shadows.

## Shapes

Controls have gently rounded corners from the control radius. Notices and passages are slightly tighter; outcome panels and the upload area are softer. The source inspector is square edged and flush with its container. Progress markers remain circular. Borders are generally one pixel; upload uses the observed dashed boundary.

## Components

### Buttons

Primary actions use burgundy and white, with the darker hover state. Secondary actions use paper, ink, and the control stroke; hover adds the reading-surface fill and burgundy border. Guided actions have a 38px minimum height and the control typography. Keyboard focus uses a 3px outline with a 3px offset. Disabled buttons use reduced opacity and an unavailable cursor. State changes are immediate; no transition duration is introduced.

### Inputs / Fields

Inputs, selects, and textareas use paper, ink, the input stroke, the control radius, and 10px 12px padding. Fields remain paired with visible labels. The case-summary textarea can resize vertically. Save feedback is adjacent to the form heading, and Save is explicit; failed saves preserve the draft and expose a retry.

### Navigation

The four destinations are Overview, Documents, Simulation, and Results. Desktop items combine a stroke icon and text in a full-width row. The current destination has a pale burgundy background, burgundy text, and stronger weight. Hover applies the existing subtle brightness change; keyboard focus stays visible. The destinations become an equal-width top row at the narrow breakpoint. Advanced tools remain behind disclosure.

### Source References

Source references are compact, underlined burgundy buttons on pale burgundy. They sit directly after the reason and wrap as a group. Locator warnings remain nearby. They open a source; their presence does not establish the source's assertions as true.

### Outcome Summary / Containers

The outcome panel uses the outcome wash, outcome radius, and documented padding. A plain-language outcome leads; ballot counts and a small segmented strip supplement it. Warnings and decision rules stay visible. Containers remain flat, while source passages use their own restrained inset surface.

### Notices

Warnings use amber text and a pale amber surface with the notice radius. Completion is separately expressed with text and an icon. Color never replaces the status wording or missing-proof explanation.

### Source Inspector

Desktop inspection preserves adjacency to the reason. The inspector has a clear title, close action, Extracted text / Original document switch, passage list, use explanation, original download, citation copying, and source details. The selected passage has an amber fill and thin outline. The narrow full-screen variant includes Back to reason, modal focus behavior, Escape dismissal, and return to the triggering source button. Loading and failure states remain readable within the inspector.

The reduced-motion query disables animation, transition, and smooth scrolling throughout the case shell. Existing SVG identity and stroke icons remain in use. This system adds no shipping raster imagery.

## Do's and Don'ts

### Do:

- Do use the existing TrialLens mark and the documented burgundy, white, ink, and sans-serif system.
- Do keep source references adjacent to the recorded reason and preserve an obvious way back from source inspection.
- Do show warning text, attempt status, valid-ballot counts, and the simulation limitation alongside the relevant content.
- Do keep visible focus, accessible control labels, and the explicit Save action with truthful saved, unsaved, saving, and failed states.
- Do allow long case names, citations, passages, and hashes to wrap within their available space.

### Don't:

- Don't present an incomplete attempt as a completed decision or a synthetic ballot distribution as a real-world verdict probability.
- Don't remove source or extraction warnings to make a result appear cleaner.
- Don't use new decorative imagery in place of preserved documents or replace the existing identity asset.
- Don't transfer historical advanced-workflow eyebrows or compact status typography into the new workspace's reusable hierarchy.
