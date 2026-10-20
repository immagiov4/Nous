---
title: "Source ingestion"
wiki_page_id: "p-doc-processing"
---

[Up one level](../01-section-overview/01-p-overview.md)

# Source ingestion

Source ingestion turns PDFs, Markdown and code archives into material that generation can retrieve selectively. Text retains page, heading or file context, while original files and extracted images keep their own references. This lets a lesson use a relevant passage without sending every source byte to a model.

## PDF extraction preserves evidence boundaries

Text extraction first attempts to preserve layout and reading order. A fallback parser can attempt extraction when the primary path is unavailable or fails, and its output can carry a quality warning. Resource limits produce an error rather than a truncated document represented as complete. The distinction matters downstream: source coverage can only reason about the material actually extracted.

Figures retain their page and nearby text. Image filtering removes likely decorative marks while retaining informational candidates; optional captions help retrieval interpret the candidate without replacing the original image or surrounding passage. A lesson reference therefore needs both file identity and the context from the correct source version. Replacing a PDF requires refreshing that context, as described in [asset lifecycle](../04-section-data/02-p-asset-management.md).

Scanned or damaged PDFs can produce unusable text. Extraction success alone does not establish that enough content exists to plan a course, so source preparation and subsequent generation validation remain separate boundaries.

## Structured text keeps its own navigation

Markdown preserves headings so sections retain context when selected. A code archive retains a file index, allowing generation and chat to search the index and retrieve particular indexed text files. Keeping the index rather than flattening an archive into one passage preserves path context and limits retrieval to its retained source version. [Context chat](07-p-chat-ui.md) explains how that boundary is enforced for conversations.

The backend's [source text services](../../../apps/backend/src/services/projectSourceText.ts), [PDF text extractor](../../../apps/backend/src/services/pdfTextExtractor.ts) and [image extractor](../../../apps/backend/src/services/pdfImageExtractor.ts) are the entry points for changes. Unsupported or invalid input returns an explicit failure; accepted input becomes context for [course planning](01-p-course-gen.md) and [lesson generation](02-p-lesson-gen.md). Their reviews assess how that material is used rather than repairing missing source bytes.
