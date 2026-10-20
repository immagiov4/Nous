# Documentation structure

Use this reference for document sets, readmes, architecture docs, manuals,
tutorials, and how-to guides.

## Scope and ownership

Inventory the requested files and directly linked material needed to decide
ownership. Extend inspection to directly related material when a demonstrated duplication
or broken path crosses the requested boundary, keeping edits within the
authorized scope and identifying connected corrections that require a broader
change. In working notes, assign each file its reader, purpose, and
documentation mode; use the role map to decide where sections belong.

Document the project's behavior, concepts, interfaces, and specific setup.
Include prerequisite material only when it helps readers use this project,
linking to the prerequisite's own documentation for further detail.

Keep one authoritative home for each fact, with short local context and links
where readers need them. Split a file when incompatible reader questions interrupt
its path or when another document already owns the detail. A short, navigable
README can remain self-contained.

Useful ownership choices:

- README: project identity, intended users, requirements, shortest successful path,
  and links to deeper material.
- Architecture: components, boundaries, data flow, constraints, and design reasons.
- Reference: facts readers look up while working, with enough context to identify
  the subject.
- Tutorial or how-to: a path to a visible result, with links to supporting reference
  or explanation.

The ownership pass is complete when every scoped section serves its file's
purpose, project relevance is clear, and duplication is limited to useful local
context. Preserve working sections during a narrow edit.

## Documentation modes

Use [Diátaxis](https://diataxis.fr/) when its modes help organize the documentation:

- **Tutorial:** learning through action. State what the reader will build and make
  each step produce a visible result. Include expected outputs and keep supporting
  explanations brief.
- **How-to:** action toward the reader's goal. Assume the relevant competence,
  state the steps directly, and include branches where judgment is needed. Link
  background material where it helps.
- **Reference:** facts for lookup. Describe options, limits, errors, and verified
  behavior in an order that matches the subject. State known facts directly and
  label uncertainty when the evidence is incomplete.
- **Explanation:** understanding a bounded topic. Develop the reasons, history,
  constraints, and trade-offs needed to answer the reader's question.

Separate modes when they interrupt the reader's task. Apply the required structure
of a report, legal notice, or supplied template when that genre governs the work.

## Reading path

Identify whether the reader needs concepts first, a guided flow with lookup
anchors, or an interface reference. Order the material accordingly. Resolve
inconsistent or overlapping structures before polishing individual passages.

A first-time reader should be able to locate the context, the first useful action,
and the next relevant detail. Consolidate repeated explanations, keep advanced
detail where readers can find it, and retain necessary qualifications beside the
behavior they qualify.

Use a table of contents when it helps navigate a long file. Collapsible
`<details>` blocks can hold advanced examples or detail that interrupts the main
path, provided the information remains accessible. Remove empty scaffolding; keep
unresolved substantive facts visible in drafts.

## Examples and provenance

Preserve examples that teach grammar or show a plausible application. Keep short
examples beside the fact they explain; move longer ones into local collapsible
blocks or an existing examples section when they interrupt the flow. Correct or
remove misleading and redundant examples.

Credit borrowed material in its appropriate citation or credit location. This
worked example illustrates the sentence-level approach:

> `budget.mjs` reads the committed budget from `budget.json` and counts the files
> that import protos. If the count exceeds the budget, CI fails. Run
> `budget.mjs --write` only to lower the budget.

The passage names the actor and actual files, states the failure condition, and
puts the restriction beside the action it governs.
