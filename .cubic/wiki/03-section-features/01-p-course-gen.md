---
title: "Course planning"
wiki_page_id: "p-course-gen"
---

[Up one level](../01-section-overview/01-p-overview.md)

# Course planning

Course generation decides what lessons should exist and in what order. It consumes an approved learning profile, requested scope, source material and available prior-knowledge evidence, then researches, drafts, verifies and refines the plan before saving it. Individual lesson explanations are generated against that saved plan.

## Inputs determine the planning problem

A topic request starts from goals and research. Document and archive requests also have prepared source content, so planning must account for the material's boundaries and structure. Course depth, lesson granularity and language proficiency affect scope and explanation requirements. Automatic settings follow supplied reference material where available and otherwise request balanced treatment.

Prior-knowledge diagnostics contribute evidence about the starting point. Their model interprets submitted attempts cumulatively and preserves uncertainty and omissions; an empty interpretation list before submission carries no assessment. The [diagnostic model](../../../apps/backend/src/workflows/priorKnowledgeDiagnosticModel.ts) owns this contract. Planning consumes that evidence rather than converting similar answers into an implicit proficiency rule.

For a course with several files, preparation freezes source identities from metadata before planning reads the originals one at a time, checking the project revision around each download. Planning receives every source name and outline with beginning, middle and end samples; archive planning uses directory, read and search tools. This keeps a whole-course source set available without loading every original into one planning request. [Ingestion](03-p-doc-processing.md) owns file admission and preparation.

## Research routing

Before retrieval, a structured decision records whether supplied material provides sufficient factual evidence and selects or skips each available research channel with a reason. Insufficient sources require a selected channel; assessed coverage gaps require external research. Sufficient sources can still benefit from a selected video demonstration, so factual coverage and pedagogical value are separate decisions.

The workflow saves this decision and executes only selected branches. A provider-unavailable failure can be tolerated when supplied sources are sufficient; other branch failures propagate. When supplied material is insufficient, the combined result must contain usable research evidence before planning continues. [Source routing](../../../apps/backend/src/services/researchSourceRouting.ts) and [research orchestration](../../../apps/backend/src/workflows/courseGenerationResearch.ts) own these boundaries.

## Draft, verify, refine, validate

The [course workflow](../../../apps/backend/src/workflows/courseGenerationWorkflow.ts) makes preparation, research, draft, verification, refinement and validation explicit stages. Verification assesses coverage, lesson boundaries and prerequisite order; refinement can address its findings before deterministic validation accepts the resulting structure. Keeping these outputs separate makes the reason for a revision inspectable and lets interrupted work resume through the workflow engine.

Once the plan is accepted, source finalization establishes the references its lessons will use, and application-exercise planning places activities against that sequence. The final persistence stage saves the course and emits its project revision. [Shared instructions](../07-section-ai/02-p-prompt-engineering.md) carry the plan's learning requirements into individual lesson drafting and review.

## Evidence stays attributable

Uploaded documents and research results retain distinct identities. Topic-based lessons use sources returned by research; a generated source title alone cannot establish retrieved evidence. [Video research](06-p-youtube-research.md) adds selected resources with selection reasoning, while [ingestion](03-p-doc-processing.md) provides document and file context. [Lesson generation](02-p-lesson-gen.md) explains how the saved plan constrains the next stage.
