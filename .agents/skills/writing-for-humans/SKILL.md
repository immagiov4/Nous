---
name: writing-for-humans
description: "Write or revise text for people, including conversation, documents, reports and messages, preserving the author's voice, the reader's competence and supported meaning. Use for human-facing prose; agent instructions follow writing-for-agents."
---

# Writing for humans

Start with what this reader needs to understand, decide or do, using the author's voice and the requested language, medium and structure. Preserve good passages and the scope of a narrow edit.

## Reader card and zoom

Before drafting, write a three-line **reader card** for yourself: who reads this, what they already know, and the one question they open it to answer (for a PR reviewer: what problem, what approach, what measurable result). Every paragraph must serve that question; a true, well-written paragraph the card does not need is cut.

Then set the **zoom**, like level of detail in a game: the top of the text is far zoom, a reader who stops after it has the answer. Zoom is separate from style and from density: plain, dense prose at the wrong zoom still fails.

- **Far zoom, always visible:** the answer in two or three sentences or a short list. Results as numbers or observable change: before/after, percent, time, count, a screenshot.
- **Near zoom, only what the card asks for:** the approach in a few lines; a before/after diagram or table when the shape of a system, flow or metric changed, instead of paragraphs describing it.
- **Deep zoom, collapsed or omitted:** procedure, file lists, test commands, edge cases, tool names. Put it in a `<details>` block titled "Details" when some reader may want it; delete it when the code, the config or the history already records it.

**Jargon budget:** name a tool, flag, file or acronym only when the reader acts on that name. "Static analysis now runs in the cloud on every PR" beats a list of the job, action, variables and project key that implement it.

Length follows the card, not the amount of work done: a large change can have a short description. If the far zoom is not readable in ten seconds, the text is not ready.

Write each plain-text or Markdown prose paragraph on one physical line and let the reader's interface wrap it visually. This includes Git commit messages, PR/MR descriptions, documentation and chat messages; fixed-width conventions such as 72-column commit bodies do not override this rule. Use blank lines between distinct paragraphs and preserve structural line breaks in code, lists, tables and other syntax. Before saving, committing or publishing, inspect the actual text for inserted line breaks inside prose paragraphs.

## Write the thought

Keep related ideas connected so each sentence develops the explanation rather than making the reader assemble isolated assertions. Put sentence boundaries where the thought changes or the syntax needs relief, retaining the useful connections between facts, reasons and consequences. Short steps work in a procedure; an argument needs its reasoning. Apply the same judgment to notes, captions and conclusions.

Choose familiar, precise words and established terms, keeping one name for each concept and making actors and references clear. Preserve product, skill and interface names in their established form; a preference for a language governs the surrounding prose unless the user requests renaming or localization. Give a qualification its specific substance beside the claim when it changes meaning or a decision. Respect the reader's existing knowledge, using the space for evidence and choices rather than reminders of obvious distinctions or imagined extreme interpretations.

Preserve attribution, quantities, dates, negation, substantive exceptions and the difference between observed behavior and plans. Match factual claims to the supplied evidence or sources actually checked, retaining unresolved facts where needed. Choose headings, lists and tables for the reading task and requested format, with emphasis carrying information rather than filling the page.

## Choose the relevant guidance

Read only the references the task calls for, alongside [prose patterns](references/prose-patterns.md) when drafting or polishing more than a brief reply:

- [Change reports](references/change-reports.md) for pull requests, issues, commit messages and status reports about work done.
- [Conversation and messages](references/conversation.md) for explanations, correspondence, progress updates and short replies.
- [Documentation](references/documentation.md) for document sets, manuals, readmes and guides; add [software reference](references/software-reference.md) when describing interfaces or observable behavior.
- [Reports](references/reports.md) for analytical, academic and project writing.
- [Legal and policy documents](references/legal-documents.md) for editorial work on obligations, notices and policies.
- [Public and persuasive writing](references/public-writing.md) for educational posts, product copy and campaigns. A marketing workflow can supply offer and audience research while this skill owns the prose and its review.

For mixed work, choose guidance by deliverable. Instructions an agent executes belong to `writing-for-agents`; apply this skill to the accompanying human-facing explanation. Tool-specific document skills own rendering and editing mechanics.

## Check and review

Before sending any prose, read it in context for the intended meaning, useful connections and the reader's level. When the user identifies a recurring defect, check every affected part, including notes, rather than repairing only the quote.

Then test each sentence against the reader card: do they already know it, or would removing it change what they understand or decide? If neither, delete it; if only some readers need it, move it into the collapsed details. How the work was done in the session, such as commands run, restarts, attempts and the writer's own process, usually fails this test.

Private responses and documents intended only for the requester use the guidance and local reread above, including substantive drafts and document-wide revisions.

For material intended for publication or for people beyond the requester, a substantive draft or rewrite, or a user-requested correction across a document, requires an independent reviewer following [independent review](references/independent-review.md). A substantive change creates or reshapes a complete explanation, message or section; a typo or a routine short conversational reply needs the local check. Within that audience scope, a request to fix the writing throughout triggers review even when individual edits are small. Apply independent review and its recheck procedure to the requested deliverable; reviewer findings and brief coordination messages use the local check, with findings assessed through the resolution procedure.

Deliver once the required content and evidence are intact, consequential findings are resolved and the affected prose has been checked again. Save or edit in the requested destination, describing the useful changes briefly when needed.
