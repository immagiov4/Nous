# Software reference

Use this reference when the document describes interfaces or observable software
behavior. Apply it alongside the structural guidance appropriate to the document.

## Verify the contract

Check the code or a reliable execution result before documenting defaults,
special values, runtime fields, callbacks, persistence, or lifecycle guarantees.
Names and existing prose are starting points for investigation.

Pay particular attention to:

- omitted values versus explicit values;
- sentinel values such as `0`, `false`, and empty tables;
- fields added to objects at runtime;
- persistent versus temporary state;
- cleanup, reset, stop, and restart behavior.

State the contract in the reference text when a reader needs it to use the
interface correctly. Include what a callback receives as `self`, which result
fields are always present, what defaults apply, and how lifecycle operations
affect existing state.

For a documented function or method, cover the applicable parts of its contract:
full signature, parameter types, required parameters, defaults, return values,
callback signatures with parameter names, and error or special-value behavior.
A known gap stays visible as a gap.

## Names and format

Use actual symbols, paths, flags, and commands from the codebase. Preserve names
and syntax in code formatting, keeping the terminology consistent with the code.

Follow the manual's requested or established entry format. When choosing a format
for a new API reference, use full signatures in **bold monospace** to make them easy to scan; describe their contracts beside them. The required
information matters more than the choice between a heading and a list entry.

Use examples to clarify the documented contract, keeping short grammar examples
near the relevant entry. Put long examples where they serve the reading path and
preserve useful complexity in advanced examples.

Make count and tree claims true at the revision being documented and record how
to regenerate them. Describe what the implementation supports; mark proposed
features and unverified behavior explicitly.

## Documentation versus product copy

Product UI strings follow the product's copy conventions. A documentation review
can identify inconsistencies, while changing UI copy remains within the user's
requested scope.
