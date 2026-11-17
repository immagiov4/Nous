# Visual defect taxonomy

This public matrix is the shared source for manual artifact inspection and the playtest inspector. Private complaint excerpts remain outside the repository.

Class-by-class inspection aims to reduce visual defects found after an artifact is declared inspected; it may increase inspection time per PR. Track both in PR verification evidence before revising the rule. The effect of this rule has not been measured.

| Family | Classes | In-page script focus | Model / external evidence |
|---|---|---|---|
| F01 — Layout and legibility | D01, D02, D03, D04, D05, D06 | Measure clipping, occlusion, approved layout/style contracts, contrast, and UI-label invariants. | Judge visual hierarchy, crowding, masking, readability, and consistency against the approved UI reference. |
| F02 — Interaction and movement | D07, D08, D09, D10, D11 | Verify action postconditions, routes, selection continuity, pointer/target trajectories, scroll position, and reload events. | Judge whether transitions, scrolling, and movement disrupt reading or control use. |
| F03 — Responsiveness and operation completion | D12, D13, D14, D15, D16 | Measure action-to-paint and loading intervals; track terminal states, browser/API failures, and progress indicators. | Judge whether feedback clearly communicates the actual operation state. |
| F04 — Library state and data lifecycle | D17, D18, D19 | Compare identities, counts, order, applied settings, reload witnesses, and lossless export/import fixtures. | Escalate only when the expected state is unavailable; a plausible screenshot cannot establish persistence. |
| F05 — Reading, markup, and annotations | D20, D21, D22 | Compare selected ranges and annotation anchors; verify renderer fixtures and text/style preservation. | Judge whether highlighting or reading emphasis obscures text or fragments its appearance. |
| F06 — Teaching and assessment quality | D23, D24, D25, D26, D27 | Check required curriculum node types, assessment structure/placement, and exact repeated content against explicit contracts. | Judge depth, useful repetition, prerequisite order, factual coherence, and assessment value from the surrounding course and sources. |
| F07 — Sources and visual explanations | D28, D29, D30, D31, D32 | Check source identity/link/extraction contracts, failed media, and accessible diagram geometry. | Judge source coverage, media relevance, diagram meaning, and the connection between visuals and lesson text. |
| F08 — In-app assistant | D33, D34, D35 | Track visible message/tool identities, saved context, action scope, continuation order, and proposal/approval transitions. | Judge task completion, dialogue role, unwanted follow-ups, and whether tool use matches the request. |
| F09 — Audio and video playback | D36, D37, D38 | Track accessible media instances, playback state, advancement, cue/clip mappings, and selection-to-playback alignment. | Judge semantic synchronization with audio when available; voice quality requires audio input. |
| F10 — Installed identity and product demonstration | D39, D40 | Collect manifest/icon metadata and demo playback/container state as supporting evidence. | Judge installed launcher screenshots and demo frame sequences against the actual product flow; launcher evidence is outside the page. |

## Visual and interaction classes

- F01: D01 clipped, D02 obscured, D03 spacing or hierarchy, D04 inconsistent styling, D05 hard to read, D06 misleading, redundant or internal text. D06 includes repeated information on one screen, internal wording and promises of unavailable actions.
- F02: D07 action without effect, D08 wrong destination, D09 broken selection, D10 drag lag, D11 unexpected movement or scrolling.
- F03: D12 slow interaction, D13 slow loading, D14 generation stalls, D15 exposed runtime failure, D16 missing or misleading feedback.
