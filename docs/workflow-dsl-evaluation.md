# Typed workflow DSL evaluation

This document records the design investigation for [issue #9](https://github.com/immagiov4/Nous/issues/9).
It evaluates ways to reduce the type and graph plumbing required to define a workflow. It does not change the
DSL or the workflow runtime.

Evidence baseline: commit `8cd5956ec2fb05806db71fcbf0719a603eee64d0`.

## Decision

The evidence supports a pipeline-first facade for linear workflows. The facade would infer each step's input
from the preceding output while keeping output schemas, stable node IDs, effects, commits, undo, and policies
visible.

The existing structural constructors should remain available for branches, fan-out, loops, waits, nested
workflows, and historical definitions. This is a design direction, not an approved implementation.

## Architecture context

The [Postgres Workflow Engine page](../.cubic/wiki/02-section-architecture/02-p-workflow-engine.md) is the
authoritative description of validation, schema fingerprints, in-memory materialization, PostgreSQL
persistence, leases, retries, provider effects, signals, undo, and historical definition resolution. This
report records only the findings that affect the DSL decision.

## Findings for #9

The definition module exposes eight constructors: `step`, `sequence`, `emit`, `waitForSignal`, `fanOut`,
`routeBy`, `repeat`, and `workflow` ([definition.ts:40](../apps/backend/src/workflows/definition.ts#L40)).
The main authoring cost is repeated input and output schemas, explicit context generics, and nested structural
values.

`sequence` propagates one `Config` and `Services` context through `FirstNodeContext` and
`CompatibleNodes` ([definition.ts:119](../apps/backend/src/workflows/definition.ts#L119),
[definition.ts:142](../apps/backend/src/workflows/definition.ts#L142)). Compile-time tests reject mixed service
contexts, incompatible roots, and invalid configuration overrides ([workflowTypes.test.ts:95](../apps/backend/tests/workflows/workflowTypes.test.ts#L95)).
The interview definition has two explicit `as unknown as WorkflowNode` casts around signal waits
([courseInterviewWorkflow.ts:536](../apps/backend/src/workflows/courseInterviewWorkflow.ts#L536),
[courseInterviewWorkflow.ts:549](../apps/backend/src/workflows/courseInterviewWorkflow.ts#L549)).

The production registry creates six top-level definitions and historical variants
([workflowRuntimeComposition.ts:189](../apps/backend/src/workflows/runtime/workflowRuntimeComposition.ts#L189)).
The starters resolve the current definition, parse the input and configuration, materialize the run, and pass
the definition hash to the store ([workflowStart.ts:41](../apps/backend/src/workflows/workflowStart.ts#L41)).
A facade therefore needs to change definition modules first. The API, worker, and database can remain unchanged
if the lowered result keeps the existing runtime contract.

Materialization produces in-memory node records. `PostgresWorkflowStore.createRun` later persists those
records through `insertMaterializedNode` ([materialization.ts:472](../apps/backend/src/workflows/materialization.ts#L472),
[postgresWorkflowStore.ts:467](../apps/backend/src/workflows/persistence/postgresWorkflowStore.ts#L467),
[postgresWorkflowPersistence.ts:26](../apps/backend/src/workflows/postgresWorkflowPersistence.ts#L26)).

The definition manifest contains structural data and excludes callback bodies. A matching manifest hash is
therefore necessary but not sufficient evidence that a rewritten definition behaves the same. The compatibility
review must also compare callback and `compatibilityId` intent, or provide behavioral coverage. Structural
hash tests remain useful evidence, but they are not the sole compatibility oracle
([validation.ts:362](../apps/backend/src/workflows/validation.ts#L362),
[workflowDefinitions.test.ts:129](../apps/backend/tests/workflows/workflowDefinitions.test.ts#L129),
[workflowDefinitions.test.ts:255](../apps/backend/tests/workflows/workflowDefinitions.test.ts#L255)).

The registry resolves historical definitions by exact workflow ID and definition hash. Resume and claim
boundaries then compare the stored hash version before using that definition. A new source form must not
replace the old definition needed to resume a persisted run ([definition.ts:501](../apps/backend/src/workflows/definition.ts#L501),
[workflowStepResolution.ts:89](../apps/backend/src/workflows/workflowStepResolution.ts#L89),
[workflowDefinitions.test.ts:273](../apps/backend/tests/workflows/workflowDefinitions.test.ts#L273)).

## Alternatives

These are design sketches. None has been implemented or runtime-tested.

### A. Minimal typed node specification

Interface:

```ts
step({ id, inputSchema, outputSchema, run, ...options });

defineWorkflow({
  id,
  compatibilityId,
  configSchema,
  executionDefaults,
  inputSchema,
  outputSchema,
  root: NodeSpec,
});
```

`NodeSpec` would be a typed recursive union for sequence, route, fan-out, repeat, emit, signal wait, and
nested workflow. The lowerer would produce the existing `WorkflowNode` union.

The lowerer must retain the existing type checks, validation errors, IDs, schemas, event and signal declarations,
and failure policies. It would depend on the existing registry, validator, materializer, and persistence path.
The interface is smaller by name, but advanced authors still provide most structural fields. Migration cost is
medium to high.

### B. Pipeline-first facade

Interface:

```ts
defineWorkflow({
  id,
  compatibilityId,
  rootSequenceId: 'course-flow',
  inputSchema,
  outputSchema,
  configSchema,
  executionDefaults,
  events,
  signals,
  flow: flow =>
    flow
      .step({ id: 'prepare', outputSchema: Prepared, run: prepare })
      .step({ id: 'draft', outputSchema: Draft, run: draft })
      .finish(),
});
```

The facade would lower the chain to an ordinary `sequence` whose durable root ID remains explicit. Branch,
fan-out, repeat, wait, emit, and nested workflow operations would remain explicit, as would the workflow-level
event and signal catalogs they require. The type must infer the input of each step and reject a transition whose
output does not match the next input. Runtime validation must still reject malformed values assembled outside
the facade.

The facade hides only sequence assembly and repeated input schemas. It keeps effects, commits, undo, policies,
stable IDs, and output schemas visible. It depends on a small lowerer over the existing definition module.
Migration cost is medium for linear definitions and low for advanced or historical definitions if they remain
unchanged. Its main risk is reproducing the existing context type machinery in a harder-to-read builder.

### C. Workflow plan with codecs and adapters

Interface:

```ts
defineWorkflowPlan({
  identity: { id, compatibilityId },
  contract: { input, output, config, events, signals },
  defaults,
  graph,
  adapters,
});
```

Adapters would declare durable input and output contracts, manifest contributions, compatibility identities,
and provider or persistence behavior. Standard graph operations would cover task, sequence, branch, map, loop,
wait, emit, and nested calls.

The plan interpreter would hide indexing, materialization, checkpoints, leases, provider-effect replay, undo,
observability, and registry integration. It would need new typed codec and adapter contracts, plus stable
errors for unknown adapters and invalid manifests. It has the largest interface and the highest migration cost.
A graph operation that cannot lower to an existing persisted node kind would also require database and worker
changes. No current consumer requires that extension point.

## Comparison

| Option | Depth and locality | Type and runtime fit | Cost and risk |
| --- | --- | --- | --- |
| Current constructors | Deep runtime, shallow authoring for advanced details | Proven and tested | No migration; repeated authoring cost |
| A. Typed node specification | Deep lowerer and one named definition entry point | Preserves the existing node union if every variant stays typed | Medium to high; structural fields remain visible |
| B. Pipeline-first facade | Deep for linear chains and good locality | Preserves the existing node and manifest model | Medium; best first scope |
| C. Plan with codecs and adapters | Potentially deep, with a much larger public contract | Adds codec, adapter, and manifest contracts | High; largest compatibility risk |

## Recommendation and approval boundary

Use B as the candidate for a first implementation proposal. Apply it to new linear workflows or one selected
linear definition. Keep the current constructors for advanced and historical definitions.

The implementation must satisfy all of these conditions:

1. The facade lowers only to existing node kinds.
2. Node IDs, namespaces, order, schemas, event and signal declarations, effects, policies, and compatibility
   IDs remain explicit where they affect durable behavior.
3. An unchanged definition produces the same manifest and definition hash.
4. The team reviews callback and `compatibilityId` equivalence, or adds behavioral coverage. Golden hash tests
   alone do not establish compatibility because callback bodies are absent from the manifest.
5. A migrated definition preserves `executionDefaults` and every persisted step policy, including configuration,
   retry count, and timeout. An intentional policy change requires explicit owner approval and behavioral coverage.
6. Historical definitions remain independently resolvable by their persisted hash and hash version.
7. Compile-time negative tests and runtime validation tests cover the same boundaries as the existing DSL.

Do not implement the facade, rewrite historical definitions, or change persisted node kinds until the owner
approves the scope and compatibility rules. The PR references issue #9 with `Refs #9`; it does not close the
issue.

## Verification record

- Issue #9 was read with `gh issue view 9 --repo immagiov4/Nous --json ... --comments`. It was open and had no comments.
- The definition, type, validation, materialization, registry, workflow-start, persistence, migration, and
  workflow test files were checked against the claims above.
- `CONTEXT.md` and ADR files are absent. The Cubic graph artifact was unavailable, so the linked wiki page and
  source files were used directly.
- This document and the linked architecture page are documentation only. Runtime equivalence of the alternatives
  is not verified.
