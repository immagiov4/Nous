---
title: "Exercise and answer state"
wiki_page_id: "p-interactive-exercises"
---

[Up one level](../03-section-features/02-p-lesson-gen.md)

# Exercise and answer state

Inline quizzes and practical exercises are different course outputs. A quiz is part of a lesson's content and stores an answer against that content; a practical exercise is a separate planned activity with a brief, response and feedback. Their identity and persistence boundaries determine what can survive navigation or regeneration.

## Inline quizzes test a distinction

A lesson can contain up to three quizzes with four choices each. Drafting and review share rules for application, prediction, diagnosis and sequencing, including plausible mistaken answers and an explanation of the correct distinction. Structural validation can enforce the output shape, while teaching review assesses whether the choices exercise the intended reasoning.

Saved responses survive navigation, reopening and export with the lesson. Successful regeneration replaces lesson content and clears its old answers and annotations: those records refer to the explanation and question identities they were created against. Failure preserves the previously saved lesson and progress. Treating a pending replacement as committed content would cross that boundary too early.

## Practical work has its own lifecycle

The course planner places application exercises against the learning sequence. Their briefs can finish generating while another lesson is already readable, so activity readiness is independent of the active reader page. A submitted response can include supported attachments and receives AI feedback against its task context.

Exercise work is persisted with project state rather than being transient component state. [Project revisions](05-p-project-workspace.md) therefore apply to saved progress as well as generated text. Follow the [shared contracts](../../../packages/shared-types/) for activity and answer shapes, and the [generation instructions](../07-section-ai/02-p-prompt-engineering.md) for shared drafting and review expectations.

Verification should distinguish content quality from state behavior. A deterministic test can establish that an answer survives reopen or is cleared only after successful replacement. Representative generated quizzes and feedback require [content evaluation](../09-section-tools/02-p-testing-quality.md#evaluate-generated-content) to establish whether the exercise actually tests the objective.
