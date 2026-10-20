---
title: "Video research pipeline"
wiki_page_id: "p-youtube-research"
---

[Up one level](01-p-course-gen.md)

# Video research pipeline

Video research discovers candidates for a course or lesson objective, compares their metadata and available transcripts, then retains selected resources with reasons. Discovery, transcript retrieval and selection are separate stages because a search result establishes availability, while selection needs evidence about its educational relevance.

## Discovery supplies candidates, selection supplies context

Research can use related searches to find complementary explanations. Transcript language and availability determine which candidate content the workflow can assess; titles and metadata remain a different evidence source from an actual transcript. A selected resource retains its identity and the reasoning behind its selection so subsequent planning and lesson generation can use it in context.

The lesson workflow has an explicit route for additional video research. Where its search plan supplies a distinct fallback query and the specific search discovers no videos, the workflow can run that alternate search before finalization. This is a defined branch in the [lesson workflow](../../../apps/backend/src/workflows/lessonGenerationWorkflow.ts), rather than a generic instruction to keep retrying until a resource appears.

## The lesson remains the primary explanation

Selected videos support an objective; the generated lesson still provides its own explanation. Transcript quality varies and a video can become unavailable, so its presence cannot stand in for the lesson's reasoning. [Lesson review](02-p-lesson-gen.md) evaluates the actual explanation and its evidence context.

The Research Lab exposes the discovery and selection stages used by generation. Its candidates, transcript status, timings and selection reasoning help developers distinguish a retrieval problem from a selection problem. The lab is an inspection surface over the research mechanism; [administrative boundaries](../05-section-frontend/03-p-admin-ui.md) describes its access boundary.

For a change to research routing, inspect the [workflow services](../../../apps/backend/src/workflows/) and evaluate recorded inputs and outputs through [testing generated content](../09-section-tools/02-p-testing-quality.md#evaluate-generated-content). Keep discovery outcomes, retrieved text and model judgment distinct in that evidence so a successful search is not reported as proof that the selected video teaches the objective.
