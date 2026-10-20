---
title: "Curriculum validation contract"
wiki_page_id: "p-curriculum-contract"
---

[Up one level](01-p-database-schema.md)

# Curriculum validation contract

Curriculum validators check caller-supplied objectives, concepts, prerequisites and mappings for identity and structural consistency. They are separate from the durable production course workflow. The caller retrieves the relevant records and authorizes access; the validators judge the provided data rather than performing that lookup or authorization.

## Identity prevents accidental cross-project matches

A curriculum belongs to an account and project incarnation. Incarnation identity prevents a deleted and recreated project from inheriting references to the earlier project. Account concepts may span courses, while objectives remain local to their course even when their wording or identifiers match. Validation must preserve that distinction rather than equating textual similarity with shared identity.

## Validation requirements

- **References:** identify the expected account, project, curriculum, lesson plan and approved planning input. Unique identifiers make those references resolvable.
- **Prerequisite preparation:** records whether required knowledge is assumed at entry, supplied by a planned lesson or unresolved. A planned preparation must identify the concept uses and objectives in its provider lesson; unresolved prerequisites and same-lesson preparations are surfaced as review requirements.

## Mapping preserves the evidence state

Mappings distinguish unreviewed, unmatched, confirmed and ambiguous results. A confirmed match retains its relation and reason; an ambiguous result retains alternatives so subsequent code can inspect the unresolved choice. Cross-course alignment distinguishes a shared account concept from partial overlap without inferring proficiency from similar wording.

Keeping the alternatives lets the caller defer a decision it cannot justify yet. It can resolve the mapping when more evidence is available rather than treating a merely similar concept as a confirmed prerequisite.

Inspect the types and results under [curriculum](../../../apps/backend/src/curriculum/) before adding a caller. Tests and generation harnesses exercise these supplied-data checks; [course planning](../03-section-features/01-p-course-gen.md) describes the production plan pipeline and its own validation.
