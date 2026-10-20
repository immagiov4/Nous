---
title: "Curriculum and Mapping Rules"
wiki_page_id: "p-curriculum-contract"
---

# Curriculum and Mapping Rules

A curriculum groups a course’s learning objectives, concepts, prerequisite relationships and planned activities. These rules describe how that information is identified and checked; they do not generate or save a curriculum by themselves.

## Ownership and identity

A curriculum belongs to one account and one project. Its identity also records the project’s current incarnation, so a deleted and recreated project cannot inherit old curriculum references by accident.

Account concepts may be shared across courses. Learning objectives belong to their own course, even when two objectives have the same wording or identifier. References to evidence or saved content must retain the identity of the system that owns it.

## Structural checks

The validator checks that references point to the expected account, project, curriculum, lesson plan and approved planning input. It checks that identifiers are unique and that prerequisite preparations fit the stated lesson order.

A planned preparation must name the concept and objectives that prepare the learner for a later lesson. A preparation in the same lesson is flagged for review. A prerequisite left unresolved is also flagged.

These checks establish that the curriculum is internally consistent. They do not determine whether a learner has mastered a concept or whether one lesson is sufficient preparation. Those decisions need content review.

## Mapping evidence

Diagnostic mappings record whether a source has not been reviewed, has no match, has a confirmed match or remains ambiguous. A confirmed match keeps its relation and reason. An ambiguous result preserves its alternatives rather than selecting one.

Cross-course alignment distinguishes shared account concepts from partial overlap. Similar wording or matching objective identifiers do not make two concepts identical. The mapping records the evidence and limitations supplied by its owner; it does not rank sources or infer proficiency.

## Verification boundary

The validators use supplied account definitions, lesson plans and resolved evidence references. They do not retrieve those records or authorize access to them. The calling service must provide the right context and enforce access.

Automated checks use synthetic examples to verify structure and reference handling.
