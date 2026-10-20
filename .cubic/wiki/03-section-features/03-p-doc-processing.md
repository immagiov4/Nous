---
title: "How source material is prepared"
wiki_page_id: "p-doc-processing"
---

[Up one level](../01-section-overview/01-p-overview.md)

# How source material is prepared

PDFs, Markdown documents and code archives become searchable material for course and lesson generation. Page and heading references let the system retrieve a relevant passage without sending the entire document to a model.

## PDF text and figures

Extraction first tries to preserve layout and reading order. A second parser can attempt text extraction if the first is unavailable or fails. A fallback result can carry a quality warning; reaching a resource limit produces an error rather than a partial document presented as complete.

Figures retain their page and nearby text. The extractor filters decorative marks while retaining likely informational images. Optional captions help identify a figure; the original image and surrounding passage remain its context.

If a scan yields unusable text, choose a readable source before building a course from it.

## Markdown and archives

Markdown retains heading structure. A code archive keeps an index of its files so generation can retrieve selected text with file context. Unsupported or invalid files produce an error so the learner can choose another source.

[Course generation](01-p-course-gen.md) explains how prepared material informs planning. For keeping or restoring the original files, see [project management](05-p-project-workspace.md).
