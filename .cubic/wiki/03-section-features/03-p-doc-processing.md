---
title: "Document Processing and PDF Extraction"
wiki_page_id: "p-doc-processing"
---

# Document processing and source material

Nous Reader accepts PDFs, Markdown documents, and code archives as course sources. It extracts text and useful figures, then keeps enough context to find relevant passages during course and lesson generation.

## PDF text

The PDF reader first tries to preserve the document's layout, which helps keep columns, tables, and reading order together. If that parser is unavailable or fails, a second parser attempts the extraction. A fallback result may include a quality warning; if extraction reaches a resource limit, the system reports an error rather than treating the document as complete.

## Figures

PDF figures are saved with their page and nearby text so a lesson can use them in context. The extractor filters small decorative marks such as icons and watermarks, while keeping images that are likely to carry information.

Optional captions can help identify a figure, but they do not replace the surrounding text or the original source.

## Finding passages

Extracted text is divided into sections that retain page and heading context. Course and lesson workflows can retrieve relevant sections without sending an entire source document to a model. Those references also help readers return to the part of the original document that supports a lesson.

## Markdown and code archives

Markdown documents keep their heading structure when indexed. Code archives are treated as source collections, so the course can refer to relevant files without flattening the whole archive into one document.

Invalid or unsupported files stop with an error so the learner can choose another source.

## Related reading

- [Project workspace](./05-p-project-workspace.md)
- [Course generation](./01-p-course-gen.md)
