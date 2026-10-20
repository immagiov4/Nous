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

Map the document set as a zoom tree: the README answers what and why, deeper
pages answer how it works and how to use it, reference sits at the leaves. Each
page follows the core reading path (click, use, pressing questions) at its own
zoom and builds on what its parents established instead of repeating it. Resolve
inconsistent or overlapping structures before polishing individual passages.

A first-time reader should be able to locate the context, the first useful action,
and the next relevant detail.

Use a table of contents when it helps navigate a long file. Collapsible
`<details>` blocks can hold advanced examples or detail that interrupts the main
path, provided the information remains accessible. Remove empty scaffolding; keep
unresolved substantive facts visible in drafts.

## Build an explanation

For a developer explanation, begin with the behavior or design problem the page must make understandable. Follow the mechanism through to its consequence. Use a concrete supported case when it makes the problem easier to see; technical readers do not need an invented dramatic hook or a general lesson about good engineering.

Choose information before repairing sentences. A true fact about the same subsystem can still interrupt the explanation. Keep facts that establish a premise, explain a mechanism, show a consequence or answer a question the preceding text raises. Give independent lookup facts a table or list when the reader needs that reference; leave unrelated implementation detail with its owner. A paragraph made longer with “also”, “therefore” or semicolons can remain the same inventory.

For example, this opening names related storage facts but gives the reader no reason to follow them:

> A workspace stores documents under an owner. Sidebar entries keep folders and document placement separately. Saves and exports use version identifiers for different purposes.

An explanation of concurrent saves can instead start with the conflict the version check resolves:

> A background task can update a document while its editor still holds an earlier copy. Saving that copy would discard the task's changes, so the client sends the version it edited and the server accepts the replacement only while that version is current. A conflict sends the editor back to the newer document before it attempts another save.

The second paragraph gives version identity a job in a sequence the reader can follow. Folder organization belongs in its own explanation or storage reference. It does not become relevant to concurrent saves merely because both concern the workspace.

Before accepting explanatory prose, reconstruct its answer in ordinary language using only what it actually says. Identify a missing premise or an unexplained subject change as a defect even when the individual assertions are accurate. Keep this check separate from verifying facts against code: source familiarity can let a reviewer supply the connections the reader is missing.

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
