---
title: "Exercise and answer state"
wiki_page_id: "p-interactive-exercises"
---

[Up one level](../03-section-features/02-p-lesson-gen.md)

# Exercise and answer state

A saved answer refers to a particular quiz in a particular lesson. Regenerating the lesson can change the question or its choices, making the old answer meaningless. Nous therefore ties inline answers to committed lesson content: they survive navigation and reopening, but a successful content replacement clears them along with the old annotations.

## Reset at replacement, not when work starts

The saved lesson stays available while regeneration runs. Its answers remain valid against that saved content, so a pending replacement must not clear them. A failed attempt preserves both the previous lesson and its progress; only the successful commit establishes the new content identities. [Lesson generation](02-p-lesson-gen.md) owns this boundary, and [project revisions](05-p-project-workspace.md) protect saved progress against concurrent writers.

## Inline quiz content and validation

Inline quizzes are generated and reviewed with the explanation they assess. They ask for application, prediction, diagnosis or sequencing, with plausible mistaken answers and feedback explaining the intended distinction. The accepted shape allows up to three quizzes with four choices each. That shape can be checked deterministically; whether the alternatives test the objective needs [content evaluation](../09-section-tools/02-p-testing-quality.md#evaluate-generated-content).

## Keep practical activity progress with its own task

Practical exercises are separately planned activities with briefs, responses and AI feedback. Their briefs can finish generating while another lesson is already readable, so readiness does not follow the active reader page. Responses can include supported attachments and are assessed against that activity's task context.

This work persists with the project rather than living only in a browser component. Follow the [shared activity and answer contracts](../../../packages/shared-types/) when changing persistence, and [instruction composition](../07-section-ai/02-p-prompt-engineering.md) when changing what drafting and feedback ask of the learner.

## Observability

The [lesson persistence tests](../../../apps/backend/tests/workflows/lessonGenerationPersistence.test.ts) inspect quiz answers before replacement, after commit and after compensation. For practical activities, the [feedback evaluator](../../../apps/web/services/openrouter/exercises/evaluation.ts) returns a score, summary, caveats and evaluation time; its [tests](../../../apps/web/tests/services/openrouter/exercises.evaluation.test.ts) cover normalization and invalid results. These are inspectable state and contract checks, not a measure of assessment accuracy: pedagogical validity and the justification for a model's score require reading the task, submission and feedback together.
