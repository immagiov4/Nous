# Independent review

Use the current chat's model for every review and recheck unless the user explicitly requests another model. Astra requires that explicit request. When dispatching a reviewer, preserve the current model through inheritance or an explicit model argument, as required by the tool; do not let a separate-context default select a different model.

## Prepare the packet

For material that meets the [independent-review trigger](../SKILL.md#check-and-review),
dispatch a fresh reviewer without the author's conversation history.
With collaboration tools, use `spawn_agent` with `fork_turns="none"`;
otherwise use an equivalent independent context when available. For a recurring
document-wide correction, use two independent readers of the same packet and
reconcile their findings; their separate passes can expose different omissions.

Give the reviewer the current complete text, purpose, audience and known prior
knowledge, genre, requested language and structure, and the relevant evidence
and genre guidance. Include genuine house-style examples when useful. Restrict
access to this packet and a separate findings destination, keeping earlier
reviews, corrected answers, grading keys and the conversation outside its scope.
Supply actual requirements as requirements, rather than a list of mistakes the
reviewer is expected to discover.

Read [review prompt](review-prompt.md) and dispatch it with the packet. Preserve
the full findings so the author can assess quotes and proposed corrections.

## Resolve findings

Check each finding against the text, brief and evidence, accepting corrections
that improve the intended meaning and rejecting unsupported edits with a
recorded reason. An independent review does not grant authority to invent facts,
rewrite the author's position or broaden the task.

Correct every occurrence of a confirmed recurring defect within the authorized
text, then give a fresh
reviewer the revised text and the same brief. A focused recheck may examine changed
sections and their surrounding reasoning; a document-wide style correction needs
the complete document again. The reviewer receives the text and requirements,
rather than the previous findings or an expected clean verdict.

Complete when consequential findings are resolved and the revised portions pass
review. If successive passes add only optional preferences, preserve the supported
text instead of rewriting by preference. Compare each pass with the author's
resolution record; when further passes reopen the same substantive conflict
without a justified correction or progress, preserve the supported text and
identify the unresolved decision. Respect any time or resource limit specified
for the task. If evidence, a conflicting requirement
or review tooling prevents completion, keep the draft and identify the concrete
unresolved step. A local reread is useful but is not an independent review.

## Judge the result

Require exact passages and reasons tied to this reader's task, reviewing both
proposed edits and omissions. A coverage declaration is useful for locating gaps;
it does not establish that every defect was found. For prompt experiments, keep
development texts separate from final cases, register expected defects before
dispatch and include adequate passages to detect unnecessary edits. Record
counts and denominators, repeatability, substantive preservation and available
time or token evidence. Report a measured result for that corpus rather than
promising a universal detection percentage.
