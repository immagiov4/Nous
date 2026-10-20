---
title: "Video research pipeline"
wiki_page_id: "p-youtube-research"
---

[Up one level](01-p-course-gen.md)

# Video research pipeline

Video research discovers candidates for a course or lesson objective, compares their metadata and available transcripts, then retains selected resources with reasons. Discovery, transcript retrieval and selection are separate stages because a search result establishes availability, while selection needs evidence about its educational relevance.

[Research routing](01-p-course-gen.md#research-routing) decides whether video retrieval adds evidence or pedagogical value before this pipeline runs. Its saved sufficiency decision also governs whether unavailable optional research can be tolerated.

## Discovery supplies candidates, selection supplies context

Research can use related searches to find complementary explanations. Transcript language, availability and an estimated input budget determine which candidates reach selection. The [research service](../../../apps/backend/src/services/youtubeResearch.ts) derives that budget from configurable context-window, output and other-prompt allowances; production calls use the service defaults. It estimates transcript tokens from character count, then requires each transcript to fit both its individual allowance and the remaining total. A transcript that does not fit is excluded with a transcript-budget diagnostic before model selection. Titles and metadata remain a different evidence source from an actual transcript. A selected resource retains its identity and the reasoning behind its selection so subsequent planning and lesson generation can use it in context.

The lesson workflow has an explicit route for additional video research. Where its search plan supplies a distinct fallback query and the specific search discovers no videos, the workflow can run that alternate search before finalization. This is a defined branch in the [lesson workflow](../../../apps/backend/src/workflows/lessonGenerationWorkflow.ts), rather than a generic instruction to keep retrying until a resource appears.

## Selection classifies every admitted candidate

When fresh lesson research receives video candidates, its model classifies each URL as selected-source or rejected, with a reason based on how the transcript supports the objective. Popularity is a secondary signal. [Research validation](../../../apps/backend/src/services/lessonGenerationResearch.ts) requires exactly one decision per supplied candidate; missing or duplicate classifications trigger correction before the result is accepted.

Source assembly retains selected newly discovered videos alongside original and existing sources. The research decision selects supporting material; drafting subsequently chooses the clip intervals used in the explanation. These stages distinguish deterministic context exclusion, model rejection and incomplete classification in diagnostic evidence.

## The lesson remains the primary explanation

Selected videos support an objective; the generated lesson still provides its own explanation. Transcript quality varies and a video can become unavailable, so its presence cannot stand in for the lesson's reasoning. [Lesson review](02-p-lesson-gen.md) evaluates the actual explanation and its evidence context.

The Research Lab exposes diagnostics for discovery, transcript retrieval and inclusion in model context through the [research route](../../../apps/backend/src/routes/youtube.ts). Its candidates, transcript status, timings and budget decisions explain which material reaches model selection. The lesson research dossier retains candidate classifications and reasons for investigating that later decision. The [administrative service boundary](../05-section-frontend/03-p-admin-ui.md) governs access to the lab.

For a change to research routing, inspect the [workflow services](../../../apps/backend/src/workflows/) and evaluate recorded inputs and outputs through [testing generated content](../09-section-tools/02-p-testing-quality.md#evaluate-generated-content). Keep discovery outcomes, retrieved text and model judgment distinct in that evidence so a successful search is not reported as proof that the selected video teaches the objective.
