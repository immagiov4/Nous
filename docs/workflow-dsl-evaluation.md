# Typed workflow DSL evaluation

This document records the design investigation for [issue #9](https://github.com/immagiov4/Nous/issues/9).
It evaluates ways to reduce the amount of type and graph plumbing in workflow definitions. It does not
change the DSL, the workflow runtime, or any persisted definition.

Evidence baseline: commit `8cd5956ec2fb05806db71fcbf0719a603eee64d0`.

## Result

The main cost is in the authoring interface. The durable runtime has separate responsibilities that should
remain intact: definition validation, schema fingerprints, node materialization, PostgreSQL persistence,
leases, retries, provider-effect replay, signals, undo, and historical definition resolution.

The best first direction is a pipeline-first facade for linear workflows. It can infer each step's input from
the preceding step while keeping output schemas, stable node IDs, effects, commits, undo, and policies visible.
The existing structural constructors should remain available for branches, fan-out, loops, waits, nested
workflows, and historical definitions.

This recommendation needs owner approval. The required compatibility condition is that the facade lowers to
the same durable node structure and manifest when the workflow's behavior has not changed.

## Verified architecture

### Definition interface

The public definition module exports eight constructors: `step`, `sequence`, `emit`, `waitForSignal`, `fanOut`,
`routeBy`, `repeat`, and `workflow` ([definition.ts:40](../apps/backend/src/workflows/definition.ts#L40)).

`step` carries data schemas, a callback, optional configuration overrides, retry and timeout policies,
external-effect classification, commit, and undo ([definition.ts:40](../apps/backend/src/workflows/definition.ts#L40)).
`sequence` infers its boundary types and enforces one `Config` and `Services` context at the type level through
`FirstNodeContext` and `CompatibleNodes` ([definition.ts:72](../apps/backend/src/workflows/definition.ts#L72),
[definition.ts:142](../apps/backend/src/workflows/definition.ts#L142)).

The type-level contract is real. The tests reject mixed service contexts, incompatible workflow roots, and
invalid configuration overrides ([workflowTypes.test.ts:95](../apps/backend/tests/workflows/workflowTypes.test.ts#L95)).
The same file verifies recursively immutable runtime configuration ([workflowTypes.test.ts:141](../apps/backend/tests/workflows/workflowTypes.test.ts#L141)).

The interface also exposes structural concerns directly. Production definitions build nested sequences,
routes, fan-outs, repeats, signal waits, events, and nested workflows in the course, lesson, interview,
visual, artifact, and PDF repair workflow modules. The interview workflow contains two explicit
`as unknown as WorkflowNode` casts around signal waits ([courseInterviewWorkflow.ts:531](../apps/backend/src/workflows/courseInterviewWorkflow.ts#L531)).

### Runtime boundary

`WorkflowNode` deliberately erases callback types for validators, registries, and persistence. Its `never`
callback types prevent internal code from invoking a callback before crossing a validated schema boundary
([types.ts:255](../apps/backend/src/workflows/types.ts#L255)).

Registration validates the complete tree, snapshots it, creates a structural manifest, and computes a
versioned hash ([definition.ts:433](../apps/backend/src/workflows/definition.ts#L433)). Runtime validation checks
root boundaries, adjacent sequence schemas, route cases, fan-out workers, repeat decisions, events, signals,
configuration, and duplicate IDs ([validation.ts:191](../apps/backend/src/workflows/validation.ts#L191),
[validation.ts:280](../apps/backend/src/workflows/validation.ts#L280),
[validation.ts:477](../apps/backend/src/workflows/validation.ts#L477)).

Materialization parses inputs at every node, creates durable node rows, selects route cases, expands fan-outs,
records repeat state, and creates waits and events ([materialization.ts:429](../apps/backend/src/workflows/materialization.ts#L429),
[materialization.ts:472](../apps/backend/src/workflows/materialization.ts#L472)). Node IDs are indexed with namespaces
for nested workflows ([workflowNodeIndex.ts:21](../apps/backend/src/workflows/workflowNodeIndex.ts#L21)).

### Real consumers

The production registry constructs six top-level workflow definitions and their historical variants
([workflowRuntimeComposition.ts:189](../apps/backend/src/workflows/runtime/workflowRuntimeComposition.ts#L189),
[workflowRuntimeComposition.ts:247](../apps/backend/src/workflows/runtime/workflowRuntimeComposition.ts#L247)). The runtime
composition passes the registry to the APIs, starters, and worker ([workflowRuntimeComposition.ts:376](../apps/backend/src/workflows/runtime/workflowRuntimeComposition.ts#L376)). Each starter resolves the current definition, parses the input and configuration, materializes the run, and
persists its definition hash ([workflowStart.ts:41](../apps/backend/src/workflows/workflowStart.ts#L41)).

The backend route layer consumes the workflow APIs through the application composition
([index.ts:292](../apps/backend/src/index.ts#L292)). A DSL change therefore affects workflow definition
modules and their tests first, then the registry boundary. It does not automatically require changes to
routes, the worker, or the database if the lowered manifest remains compatible.

## Constraints to preserve

Every alternative must keep these contracts:

- A node ID is stable and unique within its workflow namespace. Persisted runs refer to node definition IDs,
  not source-code positions ([20260729113844_create_workflow_runtime.sql:1](../supabase/migrations/20260729113844_create_workflow_runtime.sql#L1),
  [workflowNodeIndex.ts:21](../apps/backend/src/workflows/workflowNodeIndex.ts#L21)).
- The compiler-facing contract rejects incompatible `Config` and `Services` contexts. Runtime validation still
  rejects disconnected schemas, even when a manually constructed value bypasses the type checker
  ([workflowDefinitions.test.ts:926](../apps/backend/tests/workflows/workflowDefinitions.test.ts#L926)).
- Durable schemas remain canonical, deterministic, JSON-safe schemas. The fingerprint code rejects lossy
  transforms, coercion, custom callbacks, recursive schemas, and unsupported values
  ([schemaFingerprint.ts:63](../apps/backend/src/workflows/schemaFingerprint.ts#L63)).
- `commit`, `undo`, retry, timeout, lease, cancellation, provider-effect persistence, and idempotency remain
  runtime semantics. A provider result can be persisted and replayed before a later attempt continues
  ([workflowStepRunner.ts:241](../apps/backend/src/workflows/workflowStepRunner.ts#L241)).
- Events and signals remain declared, versioned, and schema-checked. A signal wait is completed through the
  typed signal path, not as an ordinary step continuation ([continuation.ts:627](../apps/backend/src/workflows/continuation.ts#L627)).
- The definition hash, request fingerprint, and domain-specific content fingerprints remain separate values.
  Structural changes alter the definition hash, while callback-only changes do not
  ([workflowDefinitions.test.ts:129](../apps/backend/tests/workflows/workflowDefinitions.test.ts#L129),
  [workflowDefinitions.test.ts:255](../apps/backend/tests/workflows/workflowDefinitions.test.ts#L255)).
- Historical definitions remain registered by their exact `(workflowId, definitionHash, definitionHashVersion)`
  boundary. The current definition cannot reconstruct every previous schema and callback contract by itself
  ([definition.ts:403](../apps/backend/src/workflows/definition.ts#L403),
  [workflowDefinitions.test.ts:273](../apps/backend/tests/workflows/workflowDefinitions.test.ts#L273)).

## Alternatives

The following alternatives are design sketches. None has been implemented or runtime-tested.

### A. Minimal typed node specification

Keep `step` as the only callback constructor and use one `defineWorkflow` entry point. Represent structural
nodes as a typed recursive value:

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

`NodeSpec` would contain typed variants for sequence, route, fan-out, repeat, emit, signal wait, and nested
workflow. The lowerer would produce the existing `WorkflowNode` union.

The type boundary must still enforce shared configuration and service contexts, schema-compatible edges,
declared events and signals, stable IDs, and the existing failure policies. Registration and materialization
errors would keep their current categories: invalid definitions, unknown events or signals, disconnected
schemas, duplicate IDs, invalid fan-out keys, and invalid repeat state.

This option gives the smallest named interface and a deep implementation boundary. Its main cost is that the
recursive value still exposes most advanced fields. It reduces the number of entry points more than it reduces
the amount of information an advanced workflow author must provide. It has medium-to-high migration cost,
although the runtime and database can remain unchanged if the lowerer emits the same manifest.

### B. Pipeline-first facade

Make the common linear case a typed pipeline. Bind `Config` and `Services` once, infer each step's input from
the previous output, and require only the output schema for each transition:

```ts
defineWorkflow({
  id,
  compatibilityId,
  inputSchema,
  outputSchema,
  configSchema,
  executionDefaults,
  flow: flow =>
    flow
      .step({ id: 'prepare', outputSchema: Prepared, run: prepare })
      .step({ id: 'draft', outputSchema: Draft, run: draft })
      .finish(),
});
```

The facade would lower to an ordinary `sequence`. `branch`, `fanOut`, `repeat`, `wait`, `emit`, and nested
workflow operations would remain explicit escape hatches rather than becoming hidden behavior.

The facade must preserve the declared workflow input and output schemas, stable IDs, output parsing, context
types, effects, commit and undo, and the same runtime error boundaries. A type error must stop a step whose
input does not match the preceding output. Registration must still catch malformed values assembled outside
the facade.

This option has the best leverage for the repeated linear chains in lesson and course workflows. It improves
locality without forcing a rewrite of advanced or historical definitions. Its cost is medium: the pipeline
type and lowerer need focused compile-time tests, and root IDs must remain configurable for compatible manifests.
Its main risk is a builder whose type machinery becomes as difficult to understand as the constructors it hides.

### C. Workflow plan with codecs and adapters

Make the definition a plan with explicit identity, durable codecs, graph operations, and service adapters:

```ts
defineWorkflowPlan({
  identity: { id, compatibilityId },
  contract: { input, output, config, events, signals },
  defaults,
  graph,
  adapters,
});
```

Each adapter would declare its durable input and output contract, manifest contribution, compatibility identity,
and provider or persistence behavior. Standard graph operations would cover task, sequence, branch, map, loop,
wait, emit, and nested calls.

The plan would need the same schema, ID, error, retry, idempotency, event, signal, and historical-resolution
invariants as the existing DSL. Unknown adapters and non-deterministic manifests would become new registration
errors. The plan interpreter would hide indexing, materialization, checkpoints, leases, provider-effect replay,
undo, observability, and the registry.

This can form a deep seam, but it introduces the largest public vocabulary and the highest adapter burden. A
new graph kind that cannot lower to an existing persisted kind would require changes to the database and worker.
Migration cost is high for the six production definitions and their historical variants. This option is not
justified by a consumer need shown in the inspected code.

## Comparison

| Option | Depth and locality | Type and runtime fit | Migration and compatibility risk |
| --- | --- | --- | --- |
| Current constructors | Deep runtime, shallow authoring for advanced details | Proven and fully exercised | No migration cost; authoring cost remains |
| A. Typed node specification | Deep lowerer; better entry-point locality | Can preserve the existing union if all variants stay typed | Medium to high; advanced fields remain visible |
| B. Pipeline-first facade | Deep for linear chains; best common-case locality | Preserves the current node and manifest model | Medium; advanced and historical definitions can stay unchanged |
| C. Plan with codecs and adapters | Potentially deep, but with a much larger interface | Adds a new codec and adapter contract to verify | High; greatest risk of new kinds or changed fingerprints |

## Recommendation and approval boundary

Adopt B as the candidate for a first implementation proposal. Keep the existing constructors as the escape
hatch and as the authoring form for historical definitions. Do not replace the runtime model, introduce new
persisted node kinds, or infer a historical definition from a new source form.

Before implementation, the owner must approve these points:

1. The facade may lower only to the existing node kinds.
2. Existing node IDs, namespaces, order, schemas, event and signal declarations, policies, and compatibility IDs
   remain explicit where they affect durable behavior.
3. An unchanged definition must produce the same manifest and definition hash. The golden hash tests remain
   the compatibility oracle.
4. Historical definitions remain independently resolvable. A new facade does not replace their source or
   callback contracts.
5. Compile-time negative tests and runtime validation tests cover the same boundaries as the current DSL.

The main open decision is whether the project wants a facade for new linear workflows only, or a complete
rewrite of all definition modules. The evidence supports the first choice. It does not support changing the
durable engine.

## Verification record

- Issue read with `gh issue view 9 --repo immagiov4/Nous --json ... --comments`. It was open and had no comments.
- Repository evidence came from the definition, type, validation, materialization, registry, workflow-start,
  persistence, migration, and workflow test files linked above.
- `CONTEXT.md` and ADR files were not present in the repository. The Cubic graph query could not run because
  `graphify-out/graph.json` was absent, so source inspection was the authority for this report.
- No tests were run because this task produced a design document and did not change runtime code.
- This report is `VERIFIED` as a source-based design investigation. The alternatives are `NOT VERIFIED` at
  runtime because none was implemented.
