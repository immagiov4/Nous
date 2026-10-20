---
name: writing-for-humans
description: "Write or revise text for people, including conversation, documents, reports and messages, preserving the author's voice, the reader's competence and supported meaning. Use for human-facing prose; agent instructions follow writing-for-agents."
---

# Writing for humans

Plan the information before the prose. Decide which question the text answers, at what zoom, for which reader, and what path keeps that reader going; only then write sentences. Polished prose on the wrong information is still unreadable. Use the author's voice and the requested language and medium, and preserve good passages and the scope of a narrow edit.

## 1. One question, one zoom

Each text answers one question. Name it in a sentence before drafting: "what is X and why should I care", "how does X work", "how do I use X for Y", "what does option Z do". These are different texts:

- **What and why** (orientation): what it is and why it exists, fused into one opening line; shown rather than described where possible. How it works gets a hint and a link, because a reader who does not yet know what X is cannot use its mechanism.
- **How it works** (explanation): assumes the reader already knows what it is; develops the mechanism at the level of the question.
- **How to use it** (task): the most common first use, step by step, to a visible result; specifics live in their own pages.
- **Lookup** (reference): facts in the subject's order, for someone who already knows what they are looking for.

When "what it is" is small, what and how can share one short text. When "what it is" already needs a page, keep how-it-works out and link to it. A long manual is a set of such texts joined by chapters and an index; each chapter still answers one question.

Zoom is recursive. A reader at a deeper document has read the levels above it: use what those levels established without repeating it. The same rules then apply inside each section and each entry.

## 2. Reader card

Write a short card for yourself before drafting:

- **Who** reads this and what they open it for. The venue decides first: a code repository's README and wiki are read by developers, so they present the product briefly and then describe the system (architecture, components, data flow, design reasons, development, deployment), not how to operate the interface or configure product settings.
- **What they already know:** their background, plus everything the levels above this text already told them.
- **What surrounds them:** the tools, concepts and news they live with. For an outside audience, research it (forums, Reddit, issue trackers, recent news) rather than guessing; an agent's own doubts are a poor proxy for a human's.
- **Pressing questions:** the few questions that, left unanswered, block the conclusion or action you want this reader to reach. Typical questions for the audience are researchable too.

Everything in the text serves this card. A true, well-written paragraph the card does not need is cut.

## 3. Reading path

People read like foragers: they keep going while each step promises more value for little effort, and leave as soon as that promise fades. Lay the text out as a path that keeps the promise fresh:

1. **Hook**, when the reader has not chosen to be here: a problem they recognise, a striking fact, a question that opens a gap they want closed. Skip it when they arrived looking (technical docs, a PR they must review); start at the click.
2. **Click**: the moment the idea lands. What it is and why it matters in one or two lines, then the strongest evidence it delivers: a measured result (before/after, "compiles 10x faster"), a screenshot, a short video, a diagram. Show something only when seeing it makes the value clearer; a tour for its own sake loses the reader. Without measurable benefits, describe plainly and let a demo carry the weight. A long text can have more than one click, each opening the next part.
3. **Use**: what the reader can now do with it: the most common first use in a few steps, and where the specifics live. When the useful action is to share, decide or approve, say that instead.
4. **Questions**: only the pressing ones from the card, answered where they naturally arise or in a short section after use. Prefer explaining the system so that its limits are evident to adding a caveat to every line; gather many limits in one place.

The path repeats at every scale: a whole site, a technical page about one component ("why is there a proxy here" → the click of the problem it solves → how it works at this page's zoom → its limits), a single section.

## 4. Choose what goes in

Treat the text as a system to refactor:

- **One home per fact.** Say it once at the right level; elsewhere, link.
- **Pressing vs blurrable.** Keep what bridges a step of reasoning the reader must make. Small details that bridge nothing are left blurred: to the code, the history, a deeper page, or a collapsed `<details>` block titled "Details".
- **Neighbouring things.** Name an external tool, library or group when this subject uses it or directly affects it and the reader cares about it ("existing type-aware linters cannot attach to the new compiler yet"). Leave out minor things that merely relate to the subject.
- **Jargon budget.** Name a tool, flag, file or acronym only when the reader acts on that name. "Static analysis now runs in the cloud on every PR" beats a list of the job, action, variables and project key behind it.
- **Positive form.** Define things by what they are and do; reserve warnings for real hazards.
- **Visuals when faster.** A diagram, table or screenshot replaces paragraphs when the shape of a system, flow or metric is the point.

Length follows the card, not the amount of work done or the number of facts available. If the opening is not understandable in ten seconds, the text is not ready. Interest is the bar rather than brevity: a longer passage that legitimately holds this reader is fine. A page must fully answer its question at its zoom; a three-line page that leaves the reader without the mechanism or the reasons fails as surely as a wall of jargon. Depth comes from mechanism and reasons, not from procedure lists. Two pages that answer the same question (a README and an index that repeats it) are one page written twice: give each its own question.

## 5. Write the prose

Write each plain-text or Markdown prose paragraph on one physical line and let the reader's interface wrap it, including commit messages, PR descriptions, documentation and chat messages; fixed-width conventions such as 72-column commit bodies do not override this. Use blank lines between paragraphs and preserve structural line breaks in code, lists, tables and other syntax.

Keep related ideas connected so each sentence develops the thought; break sentences where the thought changes. Choose familiar, precise words, one name per concept, and clear actors. Preserve product, skill and interface names in their established form. Preserve attribution, quantities, dates, negation, substantive exceptions and the difference between observed behaviour and plans, and match factual claims to evidence actually checked. Use [prose patterns](references/prose-patterns.md) when drafting or polishing more than a brief reply.

## Genre guidance

Read only the references the deliverable calls for:

- [Change reports](references/change-reports.md): pull requests, issues, commit messages, status reports.
- [Conversation and messages](references/conversation.md): explanations, correspondence, progress updates, short replies.
- [Documentation](references/documentation.md): document sets, manuals, readmes, guides; add [software reference](references/software-reference.md) for interfaces and observable behaviour.
- [Reports](references/reports.md): analytical, academic and project writing.
- [Legal and policy documents](references/legal-documents.md): obligations, notices, policies.
- [Public and persuasive writing](references/public-writing.md): posts, product pages, campaigns. A marketing workflow can supply offer and audience research; this skill owns the prose.

Instructions an agent executes belong to `writing-for-agents`; apply this skill to the accompanying human-facing explanation. Tool-specific document skills own rendering and editing mechanics.

## Check and review

Reread the draft as the reader on the card. Check: the question is answerable from the opening; every section moves along the path; each sentence either changes what this reader understands or decides, or it goes (into details, a link, or nowhere). How the work was done in the session (commands, restarts, attempts) almost never passes. When the user identifies a recurring defect, check every affected part, not only the quoted one.

Private responses and documents only for the requester use this reread. For material published or read beyond the requester, a substantive draft or rewrite, or a requested correction across a document, also requires an independent reviewer following [independent review](references/independent-review.md); a typo or a routine short reply needs only the local check.

Deliver once the content and evidence are intact, consequential findings are resolved and the affected prose has been checked again.
