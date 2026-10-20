---
title: "Curriculum validation contract"
wiki_page_id: "p-curriculum-contract"
---

[Up one level](01-p-database-schema.md)

# Curriculum validation contract

Curriculum validators check caller-supplied objectives, concepts, prerequisites and mappings for identity and structural consistency. They are separate from the durable production course workflow. The caller retrieves the relevant records and authorizes access; the validators judge the provided data rather than performing that lookup or authorization.

## Identity prevents accidental cross-project matches

A curriculum belongs to an account and project incarnation. Incarnation identity prevents a deleted and recreated project from inheriting references to the earlier project. Account concepts may span courses, while objectives remain local to their course even when their wording or identifiers match. Validation must preserve that distinction rather than equating textual similarity with shared identity.

References identify the expected account, project, curriculum, lesson plan and approved planning input. Unique identifiers make those references resolvable. When a preparation claims to support a later lesson, it must name the concept and objectives doing that work; unresolved prerequisites and same-lesson preparations remain explicit validation problems.

## Mapping preserves the evidence state

Mappings distinguish unreviewed, unmatched, confirmed and ambiguous results. A confirmed match retains its relation and reason; an ambiguous result retains alternatives so subsequent code can inspect the unresolved choice. Cross-course alignment distinguishes a shared account concept from partial overlap without inferring proficiency from similar wording.

These states let a caller retain uncertainty rather than coerce every mapping into a successful match. They establish internal consistency, while content review must assess whether a preparation is educationally sufficient. A structurally valid prerequisite edge cannot demonstrate that a learner has mastered its concept.

Inspect the types and results under [curriculum](../../../apps/backend/src/curriculum/) before adding a caller. Tests and generation harnesses exercise these supplied-data checks; [course planning](../03-section-features/01-p-course-gen.md) describes the production plan pipeline and its own validation. Keeping those boundaries explicit avoids treating a standalone validation contract as an integrated production feature.
