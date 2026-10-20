---
title: "How a course plan is built"
wiki_page_id: "p-course-gen"
---

[Up one level](../01-section-overview/01-p-overview.md)

# How a course plan is built

After the learner approves a profile, generation researches the subject and drafts an ordered sequence of lessons. Review checks coverage, boundaries and prerequisites before the plan is saved.

## Establish the starting point

A topic course uses the learner's goals; a document course also uses [prepared source material](03-p-doc-processing.md). Course depth, lesson size and language proficiency guide the scope. Automatic settings follow reference material when supplied and otherwise request a balanced treatment.

Prior-knowledge questions gather evidence about the learner's starting point. Their answers guide planning rather than assigning a grade or diagnosis.

## Research, draft and review

Web and [video research](06-p-youtube-research.md) supply supporting material. Review can request targeted revisions to the plan before it is accepted. Document sources remain distinct from research results; topic-based lessons can use only sources returned by research. The reader presents saved sources as linked titles with notes.

The approved plan becomes context for [lesson generation](02-p-lesson-gen.md). Developers changing planning rules should follow the [shared instruction contracts](../07-section-ai/02-p-prompt-engineering.md).

<details><summary>Details</summary>

When changing prior-knowledge adaptation, use the [diagnostic model](../../../apps/backend/src/workflows/priorKnowledgeDiagnosticModel.ts). Evaluations interpret submitted attempts cumulatively; before a submission, their interpretation list is empty. Uncertainty and omissions remain explicit in the evaluation.

</details>
