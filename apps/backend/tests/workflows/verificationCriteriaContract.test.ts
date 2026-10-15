import { describe, expect, test } from 'vitest';
import { prepareStrictStructuredOutput } from '../../src/services/strictStructuredOutput.js';
import {
  CoursePlanVerificationSchema,
  preVerificationCriteriaCourseGenerationStateSchemas,
} from '../../src/workflows/courseGenerationWorkflowContract.js';

const legacyReview = {
  ...Object.fromEntries(
    [
      'coverage',
      'duplication',
      'granularity',
      'moduleCohesion',
      'prerequisites',
      'progression',
      'proportionality',
    ].map(dimension => [dimension, { status: 'pass', feedback: 'The objective is covered.' }])
  ),
  fragmentation: {
    canGroupCoherently: false,
    feedback: 'The modules are coherent.',
    moduleIds: [],
  },
  summary: 'The plan meets its objectives.',
  verdict: 'pass',
};

describe('checkable verification output contracts', () => {
  test('parses historical output separately and preserves required conditions through strict output normalization', () => {
    const historical =
      preVerificationCriteriaCourseGenerationStateSchemas.CoursePlanVerificationSchema;
    expect(historical.parse(legacyReview)).toEqual(legacyReview);
    expect(CoursePlanVerificationSchema.safeParse(legacyReview).success).toBe(false);
    const current = {
      ...legacyReview,
      refinementConditions: [
        {
          dimension: 'coverage',
          passCondition: 'Include message ordering in the first lesson objective.',
        },
      ],
      conditionAssessments: [
        {
          dimension: 'coverage',
          met: true,
          evidence: 'The first lesson objective explicitly includes message ordering.',
        },
      ],
    };
    const { $schema: _dialect, ...schema } = CoursePlanVerificationSchema.toJSONSchema();
    const strict = prepareStrictStructuredOutput(schema);
    const output = CoursePlanVerificationSchema.parse(strict.normalize(current));
    expect(output.refinementConditions).toEqual(current.refinementConditions);
    expect(output.conditionAssessments).toEqual(current.conditionAssessments);
  });
});
