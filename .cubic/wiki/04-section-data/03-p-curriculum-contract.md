---
title: "Curriculum validation reference"
wiki_page_id: "p-curriculum-contract"
---

[Up one level](01-p-database-schema.md)

# Curriculum validation reference

A curriculum describes objectives, concepts, prerequisites and planned activities. These validators run on caller-supplied data and are separate from the durable course workflow. The caller retrieves records and authorizes access; validation checks their identities and references.

## Identity

A curriculum belongs to an account and project incarnation, which prevents a deleted and recreated project inheriting stale references. Account concepts can span courses; objectives remain local to their course even when wording or identifiers match.

## Structure and prerequisites

References must identify the expected account, project, curriculum, lesson plan and approved planning input. Identifiers must be unique. A preparation names the concept and objectives that prepare a later lesson; same-lesson preparations and unresolved prerequisites are flagged for review.

These checks establish internal consistency. Content review determines whether the preparation is educationally sufficient.

## Mapping evidence

Mappings distinguish unreviewed, unmatched, confirmed and ambiguous results. A confirmed match retains its relation and reason; ambiguity retains alternatives. Cross-course alignment distinguishes a shared account concept from partial overlap without inferring proficiency from similar wording.

For exact types and validation results, read the [curriculum validators](../../../apps/backend/src/curriculum/). For the production planning workflow, see [course generation](../03-section-features/01-p-course-gen.md).
