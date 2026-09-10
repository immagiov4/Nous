import { describe, expect, test } from 'vitest';
import type { CourseCurriculum } from '../../../../packages/shared-types/curriculum';
import { validateCurriculum } from '../../src/curriculum/validation';
import { curriculumFixture } from './fixtures';

describe('curriculum structural validation', () => {
  test('rejects a prerequisite whose explicit preparation state is omitted', () => {
    const { curriculum, resolved } = curriculumFixture();
    curriculum.prerequisitePreparations = [];
    expect(validateCurriculum(curriculum, resolved).success).toBe(false);
  });

  test('rejects an empty curriculum for an existing lesson plan', () => {
    const { curriculum, resolved } = curriculumFixture();
    const empty: CourseCurriculum = {
      ...curriculum,
      conceptIds: [],
      objectives: [],
      objectiveConceptLinks: [],
      lessonConceptUses: [],
      lessonObjectiveLinks: [],
      prerequisites: [],
      prerequisitePreparations: [],
      activityTargets: [],
    };
    expect(validateCurriculum(empty, resolved).success).toBe(false);
  });

  test.each([
    'conceptIds',
    'objectives',
    'objectiveConceptLinks',
    'lessonConceptUses',
    'lessonObjectiveLinks',
  ] as const)('requires %s in a curriculum for an existing plan', field => {
    const { curriculum, resolved } = curriculumFixture();
    const result = validateCurriculum({ ...curriculum, [field]: [] }, resolved);
    expect(result.success).toBe(false);
    if (!result.success)
      expect(
        result.error.issues.some(issue => issue.path.length === 1 && issue.path[0] === field)
      ).toBe(true);
  });

  test('allows a prerequisite to have explicit preparations for multiple dependent lessons', () => {
    const { curriculum, resolved } = curriculumFixture();
    resolved.lessonIds = [...resolved.lessonIds, 'lesson-3'];
    curriculum.lessonObjectiveLinks.push({
      lessonId: 'lesson-3',
      objectiveId: 'interpret-motion',
      contribution: 'Apply the interpretation to another motion example',
    });
    curriculum.prerequisitePreparations.push({
      ...curriculum.prerequisitePreparations[0],
      dependentLessonId: 'lesson-3',
    });
    expect(validateCurriculum(curriculum, resolved).success).toBe(true);
  });

  test('retains explicit relations and the immutable planning input without mutating the candidate', () => {
    const { curriculum, resolved } = curriculumFixture();
    const before = structuredClone(curriculum);
    expect(validateCurriculum(curriculum, resolved)).toEqual({
      success: true,
      data: before,
      reviewRequired: [],
    });
    expect(curriculum).toEqual(before);
  });

  const invalidRelations: [string, (curriculum: CourseCurriculum) => void, string][] = [
    [
      'another account',
      c => {
        c.ref.userId = 'other';
      },
      'ref',
    ],
    [
      'recreated project',
      c => {
        c.ref.incarnationId = 'recreated';
      },
      'ref',
    ],
    [
      'another curriculum',
      c => {
        c.ref.curriculumId = 'other';
      },
      'ref',
    ],
    [
      'another planning revision',
      c => {
        c.planningInputRef.revisionId = 'draft';
      },
      'planningInputRef',
    ],
    [
      'unresolved catalog identity',
      c => {
        c.conceptIds.push('Instantaneous rate of change');
      },
      'conceptIds',
    ],
    [
      'duplicate concept',
      c => {
        c.conceptIds.push(c.conceptIds[0]);
      },
      'conceptIds',
    ],
    [
      'duplicate objective',
      c => {
        c.objectives.push(c.objectives[0]);
      },
      'objectives',
    ],
    [
      'duplicate use',
      c => {
        c.lessonConceptUses.push(c.lessonConceptUses[0]);
      },
      'lessonConceptUses',
    ],
    [
      'duplicate requirement',
      c => {
        c.prerequisites.push(c.prerequisites[0]);
      },
      'prerequisites',
    ],
    [
      'objective owner absent from plan',
      c => {
        c.objectives[0].owner = { kind: 'lesson', lessonId: 'missing' };
      },
      'objectives',
    ],
    [
      'unresolved concept link objective',
      c => {
        c.objectiveConceptLinks[0].objectiveId = 'missing';
      },
      'objectiveConceptLinks',
    ],
    [
      'unresolved concept link concept',
      c => {
        c.objectiveConceptLinks[0].conceptId = 'missing';
      },
      'objectiveConceptLinks',
    ],
    [
      'unresolved concept use lesson',
      c => {
        c.lessonConceptUses[0].lessonId = 'missing';
      },
      'lessonConceptUses',
    ],
    [
      'unresolved concept use concept',
      c => {
        c.lessonConceptUses[0].conceptId = 'missing';
      },
      'lessonConceptUses',
    ],
    [
      'lesson objective reused by another lesson',
      c => {
        c.lessonObjectiveLinks[0].lessonId = 'lesson-2';
      },
      'lessonObjectiveLinks',
    ],
    [
      'activity targeting another lesson objective',
      c => {
        c.activityTargets[0].objectiveId = 'calculate-rate';
      },
      'activityTargets',
    ],
    [
      'activity with missing objective',
      c => {
        c.activityTargets[0].objectiveId = 'missing';
      },
      'activityTargets',
    ],
    [
      'activity with missing lesson',
      c => {
        c.activityTargets[0].lessonId = 'missing';
      },
      'activityTargets',
    ],
    [
      'requirement with missing objective',
      c => {
        c.prerequisites[0].forObjectiveId = 'missing';
      },
      'prerequisites',
    ],
    [
      'requirement with missing concept',
      c => {
        c.prerequisites[0].conceptId = 'missing';
      },
      'prerequisites',
    ],
    [
      'unresolved preparation requirement',
      c => {
        c.prerequisitePreparations[0].requirementId = 'missing';
      },
      'prerequisitePreparations',
    ],
    [
      'preparation for unrelated lesson',
      c => {
        c.prerequisitePreparations[0].dependentLessonId = 'lesson-1';
      },
      'prerequisitePreparations',
    ],
    [
      'origin from another account',
      c => {
        c.activityTargets[0].origin = { ...c.activityTargets[0].origin, userId: 'other' };
      },
      'activityTargets',
    ],
  ];
  test.each(invalidRelations)('rejects %s', (_name, mutate, field) => {
    const { curriculum, resolved } = curriculumFixture();
    mutate(curriculum);
    const result = validateCurriculum(curriculum, resolved);
    expect(result.success).toBe(false);
    if (!result.success)
      expect(result.error.issues.some(issue => issue.path[0] === field)).toBe(true);
  });

  test('rejects same concept ID resolved from another account catalog', () => {
    const { curriculum, resolved } = curriculumFixture();
    resolved.concepts = resolved.concepts.map(concept => ({ ...concept, userId: 'other' }));
    expect(validateCurriculum(curriculum, resolved).success).toBe(false);
  });

  test('keeps distinct concept identities even when their descriptions are identical', () => {
    const { curriculum, resolved } = curriculumFixture();
    resolved.concepts[1].definition = resolved.concepts[0].definition;
    resolved.concepts[1].scope = resolved.concepts[0].scope;
    const result = validateCurriculum(curriculum, resolved);
    expect(result.success && result.data.conceptIds).toEqual(['derivative', 'velocity']);
  });

  test('checks preparation precedence against the supplied plan order', () => {
    const { curriculum, resolved } = curriculumFixture();
    resolved.lessonIds = ['lesson-2', 'lesson-1'];
    expect(validateCurriculum(curriculum, resolved).success).toBe(false);
  });

  test.each([
    'missing',
    'velocity-development',
  ])('rejects preparation use %s outside its required concept and provider', useId => {
    const { curriculum, resolved } = curriculumFixture();
    const preparation = curriculum.prerequisitePreparations[0];
    if (preparation.kind !== 'planned-in-course')
      throw new Error('Fixture requires planned preparation');
    preparation.useIds = [useId];
    expect(validateCurriculum(curriculum, resolved).success).toBe(false);
  });

  test('requires preparation objectives to belong to the provider lesson', () => {
    const { curriculum, resolved } = curriculumFixture();
    const preparation = curriculum.prerequisitePreparations[0];
    if (preparation.kind !== 'planned-in-course')
      throw new Error('Fixture requires planned preparation');
    preparation.objectiveIds = ['interpret-motion'];
    expect(validateCurriculum(curriculum, resolved).success).toBe(false);
  });

  test('reports same-lesson content order for semantic review without rejecting concept co-use', () => {
    const { curriculum, resolved } = curriculumFixture();
    curriculum.lessonObjectiveLinks.push({
      lessonId: 'lesson-1',
      objectiveId: 'interpret-motion',
      contribution: 'Interpret the rate after constructing it',
    });
    curriculum.prerequisitePreparations[0].dependentLessonId = 'lesson-1';
    const result = validateCurriculum(curriculum, resolved);
    expect(result.success && result.reviewRequired).toEqual([
      { requirementId: 'rate-for-motion', lessonId: 'lesson-1', kind: 'same-lesson-order' },
    ]);
  });

  test('retains an unresolved prerequisite as a required review', () => {
    const { curriculum, resolved, origin } = curriculumFixture();
    curriculum.prerequisitePreparations = [
      {
        kind: 'unresolved',
        requirementId: 'rate-for-motion',
        dependentLessonId: 'lesson-2',
        reason: 'The course has no preparation for this capability.',
        origin,
      },
    ];
    const result = validateCurriculum(curriculum, resolved);
    expect(result.success && result.reviewRequired).toEqual([
      { requirementId: 'rate-for-motion', lessonId: 'lesson-2', kind: 'unresolved-prerequisite' },
    ]);
  });

  test('accepts an entry assumption only with a resolved support reference and retains its limits', () => {
    const { curriculum, resolved, origin } = curriculumFixture();
    curriculum.prerequisitePreparations = [
      {
        kind: 'entry-assumption',
        requirementId: 'rate-for-motion',
        dependentLessonId: 'lesson-2',
        supportRefs: [{ kind: 'diagnostic-mapping', mappingId: 'mapping-1' }],
        limitations: 'One polynomial only',
        reason: 'The diagnostic criterion addresses this calculation.',
        origin,
      },
    ];
    expect(validateCurriculum(curriculum, resolved).success).toBe(false);
    resolved.supportRefs = [{ kind: 'diagnostic-mapping', mappingId: 'mapping-1' }];
    const result = validateCurriculum(curriculum, resolved);
    expect(result.success && result.data.prerequisitePreparations).toEqual(
      curriculum.prerequisitePreparations
    );
  });

  test('rejects undeclared fields instead of silently accepting a different format', () => {
    const { curriculum, resolved } = curriculumFixture();
    expect(validateCurriculum({ ...curriculum, mastery: 1 }, resolved).success).toBe(false);
    expect(validateCurriculum({ ...curriculum, formatVersion: 2 }, resolved).success).toBe(false);
  });
});
