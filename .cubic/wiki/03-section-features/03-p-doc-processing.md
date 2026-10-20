---
title: "Source ingestion"
wiki_page_id: "p-doc-processing"
---

[Up one level](../01-section-overview/01-p-overview.md)

# Source ingestion

Generation needs the passage that supports a lesson objective, together with enough context to interpret it. Sending an entire PDF or code archive would spend context on unrelated material and obscure where a claim came from. Ingestion instead prepares retrievable text while retaining its page, heading or file location and the references to associated files.

## Keep a PDF passage with its evidence

PDF extraction attempts to preserve layout and reading order, so selected text can still be understood as a passage. Figures keep their page and nearby text for the same reason: an image without its surrounding explanation may be the wrong evidence for an objective. Filtering removes likely decorative marks, while optional captions help retrieval identify informational candidates without replacing the source image.

A figure reference must resolve against the source version that supplied this context. If a PDF is replaced, retaining an earlier caption or placement could attach the new file to an old interpretation. [Asset lifecycle](../04-section-data/02-p-asset-management.md) explains how replacement refreshes those references.

Extraction also determines what downstream research can claim to cover. A fallback parser can attempt the work when the primary path fails or is unavailable, and its result can carry a quality warning. Resource limits fail explicitly rather than presenting a truncated document as complete. Scanned or damaged PDFs may still yield too little usable text; [planning](01-p-course-gen.md#research-routing) separately decides whether the prepared evidence is sufficient.

## Preserve navigation for structured sources

Markdown headings give a selected section its place in the document. Code archives use a file index instead: generation or chat can search that index and retrieve particular indexed text files, retaining their paths and source version. This avoids flattening unrelated files into one passage and gives [contextual chat](07-p-chat-ui.md) a bounded retrieval target.

Start changes at [source text services](../../../apps/backend/src/services/projectSourceText.ts), [PDF text extraction](../../../apps/backend/src/services/pdfTextExtractor.ts) or [PDF image extraction](../../../apps/backend/src/services/pdfImageExtractor.ts), according to the lost context. Once preparation succeeds, [lesson generation](02-p-lesson-gen.md) selects and reviews how the evidence is used.
