---
title: "How a lesson is built"
wiki_page_id: "p-lesson-gen"
---

[Up one level](01-p-course-gen.md)

# How a lesson is built

Generation uses the approved plan, course preferences and relevant sources to explain one objective. It prepares context, researches where needed, drafts, checks claims and teaching quality, then prepares visuals and saves the lesson.

## Keep the explanation grounded

Factual review checks claims against the supplied material and research, including conclusions supported by stated premises. Teaching review checks the objective and prerequisite order. The [shared instructions](../07-section-ai/02-p-prompt-engineering.md) own those expectations; [source processing](03-p-doc-processing.md) owns document preparation.

A learner can request a focused follow-up lesson. It keeps the course context while addressing the requested question.

## Save and recover

Stages save progress through the [workflow engine](../02-section-architecture/02-p-workflow-engine.md). A failed attempt leaves the last saved lesson available. A successful regeneration replaces the content and resets its answers and annotations, as described under [exercise progress](08-p-interactive-exercises.md).

Structural validation checks the format; factual and teaching reviews assess the content. For changes to generation, use the [provider-backed evaluation path](../09-section-tools/02-p-testing-quality.md#evaluate-generated-content).

<details><summary>Details</summary>

Source matching prefers an explicit source ID, then a normalized URL, then a normalized title. URL normalization ignores scheme and host case and trims trailing slashes while preserving path, query and fragment case.

</details>
