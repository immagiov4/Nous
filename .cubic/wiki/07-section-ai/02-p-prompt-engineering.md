---
title: "Prompt and Generation Contracts"
wiki_page_id: "p-prompt-engineering"
---

# Prompt and Generation Contracts

Course and lesson generation share rules for clarity, learning order, source use and required output. Shared guidance helps keep the same expectations across providers and between drafting and review.

## Instructions and learner preferences

The model receives the task, the relevant learner preferences, the approved course plan and the source material needed for that task. Source documents, transcripts and quoted material are evidence to analyze, not instructions that can override the task.

Learner preferences can shape language, pace, tone and level of detail. They do not remove required course goals, factual support, safety rules or the expected output structure.

## Drafting and review

Lesson drafting and lesson review use the same learning context, while the reviewer applies a focused set of checks rather than repeating every drafting instruction. The review checks whether the lesson covers its goal, introduces ideas in a useful order, explains terms clearly and uses sources and examples appropriately.

The app validates output structure separately from teaching quality. A structurally valid response can still contain an unclear explanation or unsupported claim. Factual and pedagogical checks involve model judgment and need evidence from the lesson.

## Quizzes and exercises

Quiz instructions are shared by lesson writing and exercise generation. A quiz should test the explanation that comes before it, have one defensible answer and use plausible distractors. The explanation is shown after the learner answers, rather than revealing the solution in the lesson text.

See [Interactive exercises](../03-section-features/08-p-interactive-exercises.md) for the learner-facing behavior.

## Evaluating changes

Changes to shared instructions should be checked against representative lessons and failures. Deterministic checks can verify required structure and review evidence; they cannot replace a review of the generated lesson.

Provider-backed evaluations require an authenticated, configured provider and store evidence outside the repository. See [Testing and quality checks](../09-section-tools/02-p-testing-quality.md) for the evaluation setup.
