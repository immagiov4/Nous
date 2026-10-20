---
title: "Learning design in the generation system"
wiki_page_id: "p-manifesto"
---

[Up one level](01-p-overview.md)

# Learning design in the generation system

The generation system organizes a lesson around one learning objective and the reasoning needed to reach it. That goal constrains planning, explanation, examples and assessment. The design separates these concerns because the presence of fluent text, an image or a valid quiz structure alone cannot establish that the learner can follow the reasoning.

## Prerequisites shape explanation order

Technical terms and symbols receive their meaning when they become necessary. Required background belongs beside the idea that depends on it, and the course plan establishes ordering across lessons. Preferences can change language, pace and detail while the objective and factual requirements remain stable. [Course planning](../03-section-features/01-p-course-gen.md) turns these constraints into lesson boundaries; [instruction composition](../07-section-ai/02-p-prompt-engineering.md) carries them into drafting and review.

This is why a review needs the plan and source context as well as the generated prose. A passage can be clear sentence by sentence yet rely on a missing concept or an unsupported inference. Structural validation catches malformed output; the model reviews assess those semantic gaps.

## Visuals explain relationships

An illustration can establish an object, a scene can expose relationships, and an interactive demonstration can show changing states. Their role is to make part of the explanation easier to understand, so visual preparation is grounded in the relevant lesson passage. Source images must be available under the correct reference before the lesson relies on them.

[Playback](../03-section-features/04-p-multimedia.md) adds narration and synchronized cues to saved content. It derives its visual evidence from the block being spoken so the scene does not accidentally illustrate another part of the course.

## Application makes the distinction observable

[Quizzes and practical exercises](../03-section-features/08-p-interactive-exercises.md) ask for application, prediction, diagnosis or sequencing. Plausible mistaken answers expose the conceptual distinction being assessed. Content evaluation must inspect those explanations and feedback alongside the question, while state tests establish persistence and regeneration behavior. This division keeps educational judgment and deterministic execution evidence explicit.
