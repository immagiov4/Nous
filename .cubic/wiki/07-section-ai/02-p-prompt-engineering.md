---
title: "Instruction composition and review"
wiki_page_id: "p-prompt-engineering"
---

[Up one level](../01-section-overview/02-p-manifesto.md)

# Instruction composition and review

Generation instructions combine common teaching expectations with task-specific context and a structured result contract. Drafting and review share the learning objective, prerequisite expectations and source-use rules so the reviewer can assess the same task the writer received. Provider adapters translate transport and schema details separately.

## Context supplies evidence, not authority

Requests combine the task, course preferences, approved plan and relevant source material. Preferences shape language, pace, tone and detail while required objectives and output contracts remain in force. Retrieved documents and transcripts are evidence to analyze; their embedded instructions cannot override the application's task.

This composition prevents source content from quietly becoming a higher-priority instruction and keeps course meaning stable across providers. It also creates a concrete review target: the explanation should reach the planned objective using admissible evidence, rather than simply sounding plausible in isolation.

## Separate structural and semantic checks

Schemas establish fields, types and accepted shapes. Factual review assesses supported claims and deductions; teaching review assesses prerequisites, connected reasoning and objective coverage. Quizzes use shared drafting and review rules for application and plausible misconceptions. [Exercise state](../03-section-features/08-p-interactive-exercises.md) describes their persisted behavior, while [learning design](../01-section-overview/02-p-manifesto.md) explains the educational reasons.

A changed instruction can affect drafting, review and provider-specific request construction. Inspect the shared instruction owners under [backend services](../../../apps/backend/src/services/) and the [lesson instruction packs](../../../apps/web/utils/learning/lessonInstructionPacks.ts) before editing a local prompt. Keeping the rule at its common owner prevents one stage from asking for content that another stage rejects.

## Evaluate the explanation that results

Use representative lessons and known failures through [content evaluation](../09-section-tools/02-p-testing-quality.md#evaluate-generated-content). Deterministic tests can exercise composition precedence, schemas, parsing and evidence contracts. Reading the saved explanation and captured exchanges establishes whether the changed instruction improved its reasoning. A test that only finds a sentence inside a prompt freezes wording without proving that the generated result satisfies the intended teaching contract.
