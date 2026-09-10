# Curriculum contracts and structural validation

The first implementation block of [#119](https://github.com/immagiov4/Nous/issues/119) defines a course curriculum and explicit diagnostic and cross-course mappings. These modules operate on supplied data. The [approved design](../proposals/119-curriculum-graph.md) describes the subsequent generation, persistence, retrieval and lesson-consumption work.

## Ownership and identity

[curriculum.ts](../../../packages/shared-types/curriculum.ts) defines account-owned concepts, course or lesson objectives, concept uses, prerequisite requirements and preparations, and planned activity targets. A curriculum reference contains `userId`, `projectId`, `incarnationId` and `curriculumId`. Lesson and objective IDs inside the aggregate inherit that reference. External entity references include it explicitly, so identical positional IDs in two courses remain distinct.

Concept definitions come from the resolved account catalog. A shared concept ID identifies the same definition across that account's courses. Objectives remain local. Definitions with equal text keep their supplied identities.

`planningInputRef` identifies the immutable approved input owned by #85. Its preferences, including the explicit default `auto`, remain in that artifact. The graph assigns no numeric interpretation to depth or granularity.

`CurriculumArtifactRef` is a coordinate for retained content owned by another subsystem. The loader must resolve it and preserve its lifetime. A syntactically valid reference alone does not prove that the artifact exists or that an origin's semantic claims are correct.

## Pure validators

[validateCurriculum](../../../apps/backend/src/curriculum/validation.ts) parses a strict format and validates it against the expected curriculum identity, approved planning input, canonical account definitions, ordered lesson IDs and resolved support references. It returns either Zod issues with paths or the parsed curriculum and `reviewRequired` entries.

The caller supplies authoritative context from the same candidate plan and authorized account. Catalog definitions and resolved support references are loader responsibilities. These functions perform no I/O and are not an authorization boundary.

The validator checks unique entity IDs, reference existence, lesson ownership and preparation relations. A nonempty lesson plan requires concepts, objectives and concept/lesson relations. Every prerequisite requires an explicit preparation state; several dependent lessons may have their own preparations for one requirement. A planned preparation must cite uses of the required concept and objectives in its provider lesson. That lesson must precede or equal the dependent lesson in the supplied plan. Same-lesson preparation returns `same-lesson-order` for content review. An explicit unresolved preparation returns `unresolved-prerequisite`. A successful structural result does not establish prerequisite sufficiency or learner competence.

Entry assumptions refer to retained diagnostic mappings or cross-course alignments resolved for the destination curriculum. Their reasons and limitations remain explicit. The validator does not choose a source, rank evidence or infer proficiency from a concept role.

## Diagnostic and cross-course mappings

[curriculumMapping.ts](../../../packages/shared-types/curriculumMapping.ts) distinguishes `not-reviewed`, `unmatched`, `matched` and `ambiguous`. A confirmed match contains one or more targets. Each diagnostic target retains its own relation scope and reason, distinct from the source claim's scope. Ambiguity preserves alternative target groups with their relation context. Strict schemas reject contradictory fields, empty confirmed groups and incomplete source coordinates.

The collection schemas require unique mapping IDs within each mapping kind and destination curriculum. Ambiguous groups must differ structurally: member order alone does not create an alternative. The comparison preserves differences in declared scope and reason; it performs no semantic text classification.

[validateDiagnosticMapping](../../../apps/backend/src/curriculum/mappingValidation.ts) accepts an authoritative projection of complete source tuples from #112. A criterion observation includes the diagnostic revision, node, task, attempt, interpretation, claim, criterion and evidence artifact reference. The whole tuple must resolve together. Independent lists of existing IDs are insufficient because they could combine different episodes.

The #112 adapter will produce these tuples from its retained artifact. It owns `claim.scope`, responses, assistance, interpretation and collection context. The mapping preserves their reference instead of copying or widening their contents. Node and self-report sources remain separate from criterion observations.

`validateCrossCourseAlignment` checks the source and destination against two resolved curricula in the same account. `same-concept` requires concept references with the same account concept ID. `partial-overlap` retains distinct identities and a stated common scope, differences, reason and limitations. Equal objective IDs never make objectives the same concept. #120 owns observation retrieval and chronology; #121 owns permitted pedagogical decisions.

## Verification and integration boundary

[curriculum tests](../../../apps/backend/tests/curriculum) cover ownership, recreated projects, reference chains, local objective scope, prerequisite order, uncertainty and identity-preserving cross-course reuse. The fixtures contain synthetic educational examples.

[generation.integration.test.ts](../../../apps/backend/tests/curriculum/generation.integration.test.ts) passes synthetic responses through the production `createCourseObjectGenerator` adapter, including schema conversion, provider JSON parsing and the new validators. It demonstrates why provider-valid JSON can still contain invalid references. Provider calls are substituted in the deterministic suite.

The shared [generation harness](../../../apps/backend/tests/curriculum/generationHarness.ts) also supports an occasional real provider call. This boundary verifies generation and validation without installing the graph in the durable course workflow. Historical course, interview, lesson and PDF-repair schemas and registry composition remain outside these modules' dependency path.

A local probe on 10 September 2026 used the configured Codex course slot, `gpt-5.6-luna` with medium reasoning, and a short user-authorized source excerpt about play and learning. The generated two-lesson curriculum and both mappings passed structural validation. The model retained the assisted criterion observation as a limited match and the broader self-report as ambiguous. This probe preceded the review correction that added per-target diagnostic scope and reason; deterministic adapter tests cover that final shape. This single observation verifies provider compatibility and the exercised references, not general pedagogical quality. The source text is absent from repository fixtures and reports.

Publication, authorized storage and retrieval, integration with #85/#112 artifacts, durable workflow routing, activity execution and additive extensions remain subsequent #119 blocks. The issue remains open until those agreed scopes and their verification are complete.
