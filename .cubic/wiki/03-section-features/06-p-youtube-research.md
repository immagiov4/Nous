---
title: "Video research pipeline"
wiki_page_id: "p-youtube-research"
---

[Up one level](01-p-course-gen.md)

# Video research pipeline

Finding a video does not establish that it helps explain a lesson objective. The research pipeline must retrieve enough evidence to compare candidates, then record which ones support the objective and why. These stages also explain why a discovered video may never appear in a lesson: it can be excluded before the model sees it or rejected during selection.

[Research routing](01-p-course-gen.md#research-routing) first decides whether video research adds factual evidence or pedagogical value. Its saved sufficiency decision determines whether unavailable optional research can be tolerated; the pipeline runs only when selected.

## Decide which candidates can reach selection

Searches discover candidates and transcript retrieval supplies evidence about their content. Related queries can find complementary explanations. In the lesson workflow, a search discovering no videos can use an alternate query when its plan supplies a distinct fallback; this is a defined branch, not an open-ended search loop.

Transcripts must fit the selection request. The [research service](../../../apps/backend/src/services/youtubeResearch.ts) estimates an input budget from configurable context-window, output and other-prompt allowances; production calls use its defaults. Character counts estimate transcript tokens, and each transcript must fit both its individual allowance and the remaining total. One that does not fit is excluded with a transcript-budget diagnostic before model selection. A title or description can remain available, but it is different evidence from the excluded transcript.

## Account for every candidate the model receives

For fresh lesson research, the model classifies each supplied URL as selected-source or rejected and gives a reason based on its support for the objective. Popularity is secondary to that support. [Research validation](../../../apps/backend/src/services/lessonGenerationResearch.ts) requires exactly one classification per candidate; missing or duplicate decisions trigger correction before acceptance.

Source assembly retains selected discoveries alongside original and existing sources. Drafting then chooses clip intervals for the explanation. Selection establishes a supporting resource, while the lesson still needs to explain the objective in its own reasoning rather than depend on the video remaining available.

## Locate the decision that removed a video

The Research Lab's [retrieval diagnostics](../../../apps/backend/src/routes/youtube.ts) show discovery, transcript status, timings and admission to model context. They can explain a budget exclusion, but the later model decision belongs in the lesson research dossier, which retains candidate classifications and reasons. Follow [administrative access](../05-section-frontend/03-p-admin-ui.md) for the lab boundary and [content evaluation](../09-section-tools/02-p-testing-quality.md#evaluate-generated-content) to inspect the resulting lesson and its captured evidence.

## Observability

The [research diagnostic builder](../../../apps/backend/src/services/youtubeResearch.ts) records transcript lookup time, attempts, cache use and admission decisions such as `no-transcript`, `transcript-budget` and `context-included`. The authenticated administrator lab route linked above returns these diagnostics for retrieval inspection. Admission establishes only which evidence reached selection: it does not prove that the selected video supports the objective. Inspect the later candidate classifications and resulting lesson to assess that distinction.
