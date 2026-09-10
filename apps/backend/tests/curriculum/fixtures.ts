import type {
  ConceptDefinition,
  CourseCurriculum,
  CurriculumArtifactRef,
  CurriculumEntityRef,
  CurriculumRef,
} from '../../../../packages/shared-types/curriculum';
import type {
  CrossCourseAlignment,
  DiagnosticCurriculumMapping,
  DiagnosticMappingSource,
} from '../../../../packages/shared-types/curriculumMapping';
import type { CurriculumValidationContext } from '../../src/curriculum/validation';

export function curriculumFixture() {
  const ref: CurriculumRef = {
    userId: 'learner',
    projectId: 'physics',
    incarnationId: 'physics-incarnation',
    curriculumId: 'physics-curriculum',
  };
  const origin: CurriculumArtifactRef = {
    userId: ref.userId,
    projectId: ref.projectId,
    incarnationId: ref.incarnationId,
    artifactId: 'planning-input',
    revisionId: 'approved',
  };
  const motivation = { reason: 'The velocity calculation requires the rate of change.', origin };
  const concepts: ConceptDefinition[] = [
    {
      userId: ref.userId,
      conceptId: 'derivative',
      definition: 'Instantaneous rate of change',
      scope: 'Single real variable',
      origin,
    },
    {
      userId: ref.userId,
      conceptId: 'velocity',
      definition: 'Instantaneous velocity',
      scope: 'Motion along one axis',
      origin,
    },
  ];
  const curriculum: CourseCurriculum = {
    formatVersion: 1,
    ref,
    planningInputRef: origin,
    conceptIds: concepts.map(concept => concept.conceptId),
    objectives: [
      {
        objectiveId: 'calculate-rate',
        owner: { kind: 'lesson', lessonId: 'lesson-1' },
        performance: 'Calculate a derivative',
        conditions: 'Polynomial given without hints',
        successCriterion: 'Correct derivative and explanation',
        origin,
      },
      {
        objectiveId: 'interpret-motion',
        owner: { kind: 'course' },
        performance: 'Interpret velocity from position',
        conditions: 'One-dimensional motion',
        successCriterion: 'Correct calculation and physical interpretation',
        origin,
      },
    ],
    objectiveConceptLinks: [
      {
        objectiveId: 'calculate-rate',
        conceptId: 'derivative',
        aspect: 'Calculation',
        ...motivation,
      },
      {
        objectiveId: 'interpret-motion',
        conceptId: 'velocity',
        aspect: 'Physical interpretation',
        ...motivation,
      },
    ],
    lessonConceptUses: [
      {
        useId: 'rate-introduction',
        lessonId: 'lesson-1',
        conceptId: 'derivative',
        role: 'introduced',
        scope: 'Polynomial rate',
        ...motivation,
      },
      {
        useId: 'velocity-development',
        lessonId: 'lesson-2',
        conceptId: 'velocity',
        role: 'developed',
        scope: 'Physical meaning',
        ...motivation,
      },
    ],
    lessonObjectiveLinks: [
      {
        lessonId: 'lesson-1',
        objectiveId: 'calculate-rate',
        contribution: 'Construct the rate calculation',
      },
      {
        lessonId: 'lesson-2',
        objectiveId: 'interpret-motion',
        contribution: 'Apply the calculation to motion',
      },
    ],
    prerequisites: [
      {
        requirementId: 'rate-for-motion',
        forObjectiveId: 'interpret-motion',
        conceptId: 'derivative',
        requiredCapability: 'Calculate a polynomial derivative',
        ...motivation,
      },
    ],
    prerequisitePreparations: [
      {
        kind: 'planned-in-course',
        requirementId: 'rate-for-motion',
        dependentLessonId: 'lesson-2',
        providerLessonId: 'lesson-1',
        useIds: ['rate-introduction'],
        objectiveIds: ['calculate-rate'],
        ...motivation,
      },
    ],
    activityTargets: [
      {
        activityPlanId: 'motion-task',
        lessonId: 'lesson-2',
        objectiveId: 'interpret-motion',
        expectedPerformance: 'Explain the velocity obtained from the derivative',
        ...motivation,
      },
    ],
  };
  const resolved: CurriculumValidationContext = {
    ref: structuredClone(ref),
    planningInputRef: structuredClone(origin),
    concepts,
    lessonIds: ['lesson-1', 'lesson-2'],
    supportRefs: [],
  };
  return { curriculum, resolved, origin };
}

export function diagnosticFixture() {
  const { curriculum, origin } = curriculumFixture();
  const source: Extract<DiagnosticMappingSource, { kind: 'observation' }> = {
    kind: 'observation',
    assessmentRef: {
      userId: origin.userId,
      projectId: origin.projectId,
      incarnationId: origin.incarnationId,
      diagnosticId: 'initial-diagnosis',
      revisionId: 'retained-revision',
    },
    nodeId: 'rates',
    taskId: 'differentiate-polynomial',
    attemptId: 'attempt-1',
    interpretationId: 'interpretation-1',
    claimId: 'calculate-rate',
    criterionId: 'correct-rule',
    evidenceRef: { ...origin, artifactId: 'evidence-1', revisionId: 'interpreted' },
  };
  const entity: CurriculumEntityRef = {
    kind: 'concept',
    curriculum: curriculum.ref,
    conceptId: 'derivative',
  };
  const target = {
    target: entity,
    scope: 'Applying the polynomial derivative rule',
    reason: 'The criterion observes this aspect of the concept.',
  };
  const mapping: DiagnosticCurriculumMapping = {
    mappingId: 'diagnostic-link',
    curriculum: curriculum.ref,
    origin,
    source: structuredClone(source),
    reason: 'The criterion observes the derivative rule.',
    limitations: 'One polynomial; does not establish physical interpretation.',
    outcome: { status: 'matched', targets: [target] },
  };
  return {
    mapping,
    resolved: { curriculum, assessmentRef: source.assessmentRef, sources: [source] },
    source,
    target,
  };
}

export function crossCourseFixture() {
  const { curriculum: destination, origin } = curriculumFixture();
  const source = structuredClone(destination);
  source.ref = {
    ...source.ref,
    projectId: 'calculus',
    incarnationId: 'calculus-incarnation',
    curriculumId: 'calculus-curriculum',
  };
  const mapping: CrossCourseAlignment = {
    mappingId: 'calculus-to-physics',
    curriculum: destination.ref,
    origin,
    source: { kind: 'concept', curriculum: source.ref, conceptId: 'derivative' },
    reason: 'Both courses use the same derivative definition.',
    limitations: 'Physical interpretation remains a separate objective.',
    outcome: {
      status: 'matched',
      targets: [
        {
          target: { kind: 'concept', curriculum: destination.ref, conceptId: 'derivative' },
          relationship: 'same-concept',
          commonScope: 'Polynomial differentiation',
          differences: 'The destination applies it to motion.',
        },
      ],
    },
  };
  return { mapping, resolved: { source, destination } };
}
