import { describe, expect, test } from 'vitest';
import type { CurriculumEntityRef } from '../../../../packages/shared-types/curriculum';
import {
  validateCrossCourseAlignment,
  validateDiagnosticMapping,
} from '../../src/curriculum/mappingValidation';
import { crossCourseFixture, diagnosticFixture } from './fixtures';

describe('diagnostic curriculum mapping', () => {
  test('requires the scope and reason of each target relation independently of the source claim', () => {
    const { mapping, resolved, target } = diagnosticFixture();
    const withoutRelationContext = {
      ...mapping,
      outcome: { status: 'matched', targets: [target.target] },
    };
    expect(validateDiagnosticMapping(withoutRelationContext, resolved).success).toBe(false);
  });

  test('retains the complete criterion observation without widening it to its node', () => {
    const { mapping, resolved } = diagnosticFixture();
    const before = structuredClone({ mapping, resolved });
    const result = validateDiagnosticMapping(mapping, resolved);
    expect(result.success && result.data).toEqual(before.mapping);
    expect({ mapping, resolved }).toEqual(before);
  });

  test.each([
    'nodeId',
    'taskId',
    'attemptId',
    'interpretationId',
    'claimId',
    'criterionId',
  ] as const)('rejects a mixed episode through %s even when that ID exists in another episode', field => {
    const { mapping, resolved, source } = diagnosticFixture();
    const otherSource = {
      ...source,
      taskId: 'other-task',
      attemptId: 'other-attempt',
      interpretationId: 'other-interpretation',
      claimId: 'other-claim',
      criterionId: 'other-criterion',
      nodeId: 'other-node',
    };
    resolved.sources.push(otherSource);
    if (mapping.source.kind !== 'observation') throw new Error('Fixture requires an observation');
    mapping.source[field] = otherSource[field];
    expect(validateDiagnosticMapping(mapping, resolved).success).toBe(false);
  });

  test.each([
    'userId',
    'projectId',
    'incarnationId',
    'diagnosticId',
    'revisionId',
  ] as const)('rejects source with another %s', field => {
    const { mapping, resolved } = diagnosticFixture();
    mapping.source.assessmentRef[field] = 'another';
    expect(validateDiagnosticMapping(mapping, resolved).success).toBe(false);
  });

  test('rejects another evidence revision or evidence belonging to another course', () => {
    const { mapping, resolved } = diagnosticFixture();
    if (mapping.source.kind !== 'observation') throw new Error('Fixture requires an observation');
    mapping.source.evidenceRef.revisionId = 'another';
    expect(validateDiagnosticMapping(mapping, resolved).success).toBe(false);
    resolved.sources = [structuredClone(mapping.source)];
    mapping.source.evidenceRef.projectId = 'another';
    resolved.sources = [structuredClone(mapping.source)];
    expect(validateDiagnosticMapping(mapping, resolved).success).toBe(false);
  });

  test('validates a node source without manufacturing evidence', () => {
    const { mapping, resolved, source } = diagnosticFixture();
    mapping.source = { kind: 'node', assessmentRef: source.assessmentRef, nodeId: source.nodeId };
    const result = validateDiagnosticMapping(mapping, { ...resolved, sources: [mapping.source] });
    expect(result.success && result.data.source).toEqual(mapping.source);
  });

  test('keeps a self-report distinct from a criterion observation', () => {
    const { mapping, resolved, source } = diagnosticFixture();
    mapping.source = {
      kind: 'self-report',
      assessmentRef: source.assessmentRef,
      nodeId: source.nodeId,
      selfReportId: 'declaration',
      selfReportRef: { ...source.evidenceRef, artifactId: 'declaration-artifact' },
    };
    expect(validateDiagnosticMapping(mapping, resolved).success).toBe(false);
    const withReport = { ...resolved, sources: [mapping.source] };
    expect(validateDiagnosticMapping(mapping, withReport).success).toBe(true);
    mapping.source.selfReportRef = { ...mapping.source.selfReportRef, revisionId: 'changed' };
    expect(
      validateDiagnosticMapping(mapping, {
        ...resolved,
        sources: [{ ...mapping.source, selfReportRef: source.evidenceRef }],
      }).success
    ).toBe(false);
  });

  test('accepts explicit one-to-many matches and preserves alternative groups', () => {
    const { mapping, resolved, target } = diagnosticFixture();
    const objective: CurriculumEntityRef = {
      kind: 'objective',
      curriculum: resolved.curriculum.ref,
      objectiveId: 'calculate-rate',
    };
    const objectiveRelation = {
      target: objective,
      scope: 'Justifying the rule in the local objective',
      reason: 'The response includes the rule used for the calculation.',
    };
    mapping.outcome = { status: 'matched', targets: [target, objectiveRelation] };
    expect(validateDiagnosticMapping(mapping, resolved).success).toBe(true);
    mapping.outcome = {
      status: 'ambiguous',
      alternatives: [[target], [target, objectiveRelation]],
    };
    const result = validateDiagnosticMapping(mapping, resolved);
    expect(result.success && result.data.outcome).toEqual(mapping.outcome);
  });

  test.each([
    'not-reviewed',
    'unmatched',
  ] as const)('preserves %s and rejects contradictory targets', status => {
    const { mapping, resolved, target } = diagnosticFixture();
    mapping.outcome = { status };
    expect(validateDiagnosticMapping(mapping, resolved).success).toBe(true);
    expect(
      validateDiagnosticMapping({ ...mapping, outcome: { status, targets: [target] } }, resolved)
        .success
    ).toBe(false);
  });

  test('rejects empty matches, empty alternative groups and duplicate targets', () => {
    const { mapping, resolved, target } = diagnosticFixture();
    for (const outcome of [
      { status: 'matched', targets: [] },
      { status: 'matched', targets: [target, target] },
      { status: 'ambiguous', alternatives: [[target]] },
      { status: 'ambiguous', alternatives: [[target], []] },
    ])
      expect(validateDiagnosticMapping({ ...mapping, outcome }, resolved).success).toBe(false);
  });

  test('rejects an identically named objective from another curriculum', () => {
    const { mapping, resolved } = diagnosticFixture();
    mapping.outcome = {
      status: 'matched',
      targets: [
        {
          target: {
            kind: 'objective',
            curriculum: { ...resolved.curriculum.ref, curriculumId: 'another' },
            objectiveId: 'calculate-rate',
          },
          scope: 'Applying the derivative rule',
          reason: 'The criterion observes calculation.',
        },
      ],
    };
    expect(validateDiagnosticMapping(mapping, resolved).success).toBe(false);
  });

  test('rejects a missing concept or objective target', () => {
    const { mapping, resolved } = diagnosticFixture();
    mapping.outcome = {
      status: 'matched',
      targets: [
        {
          target: { kind: 'concept', curriculum: resolved.curriculum.ref, conceptId: 'missing' },
          scope: 'Applying the rule',
          reason: 'A calculation was observed.',
        },
        {
          target: {
            kind: 'objective',
            curriculum: resolved.curriculum.ref,
            objectiveId: 'missing',
          },
          scope: 'Justifying the rule',
          reason: 'The explanation cites this rule.',
        },
      ],
    };
    const result = validateDiagnosticMapping(mapping, resolved);
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues).toHaveLength(2);
  });
});

describe('cross-course alignment', () => {
  test('reuses account concept identity across qualified courses while preserving limits', () => {
    const { mapping, resolved } = crossCourseFixture();
    const before = structuredClone({ mapping, resolved });
    const result = validateCrossCourseAlignment(mapping, resolved);
    expect(result.success && result.data).toEqual(before.mapping);
    expect({ mapping, resolved }).toEqual(before);
  });

  test('permits an explicit partial overlap without merging concept identities', () => {
    const { mapping, resolved } = crossCourseFixture();
    mapping.outcome = {
      status: 'matched',
      targets: [
        {
          target: { kind: 'concept', curriculum: resolved.destination.ref, conceptId: 'velocity' },
          relationship: 'partial-overlap',
          commonScope: 'Rates of change',
          differences: 'Physical meaning of velocity is additional.',
        },
      ],
    };
    expect(validateCrossCourseAlignment(mapping, resolved).success).toBe(true);
    mapping.outcome.targets[0].relationship = 'same-concept';
    expect(validateCrossCourseAlignment(mapping, resolved).success).toBe(false);
  });

  test('keeps local objectives distinct even when both course IDs for the objective match', () => {
    const { mapping, resolved } = crossCourseFixture();
    mapping.source = {
      kind: 'objective',
      curriculum: resolved.source.ref,
      objectiveId: 'calculate-rate',
    };
    mapping.outcome = {
      status: 'matched',
      targets: [
        {
          target: {
            kind: 'objective',
            curriculum: resolved.destination.ref,
            objectiveId: 'calculate-rate',
          },
          relationship: 'same-concept',
          commonScope: 'Calculation',
          differences: 'Different contexts',
        },
      ],
    };
    expect(validateCrossCourseAlignment(mapping, resolved).success).toBe(false);
    mapping.outcome.targets[0].relationship = 'partial-overlap';
    expect(validateCrossCourseAlignment(mapping, resolved).success).toBe(true);
  });

  test.each([
    'userId',
    'incarnationId',
    'curriculumId',
  ] as const)('rejects a source reference with another %s', field => {
    const { mapping, resolved } = crossCourseFixture();
    mapping.source.curriculum = { ...mapping.source.curriculum, [field]: 'another' };
    expect(validateCrossCourseAlignment(mapping, resolved).success).toBe(false);
  });

  test('rejects another account even if the source reference resolves', () => {
    const { mapping, resolved } = crossCourseFixture();
    resolved.source.ref.userId = 'another-account';
    expect(validateCrossCourseAlignment(mapping, resolved).success).toBe(false);
  });

  test('requires a source course distinct from the destination', () => {
    const { mapping, resolved } = crossCourseFixture();
    mapping.source.curriculum = resolved.destination.ref;
    expect(
      validateCrossCourseAlignment(mapping, {
        source: resolved.destination,
        destination: resolved.destination,
      }).success
    ).toBe(false);
  });

  test('retains ambiguous alignments and states without a selected target', () => {
    const { mapping, resolved } = crossCourseFixture();
    if (mapping.outcome.status !== 'matched') throw new Error('Fixture requires a match');
    const candidates = mapping.outcome.targets;
    const second = {
      ...candidates[0],
      target: {
        kind: 'concept' as const,
        curriculum: resolved.destination.ref,
        conceptId: 'velocity',
      },
      relationship: 'partial-overlap' as const,
    };
    mapping.outcome = { status: 'ambiguous', alternatives: [candidates, [second]] };
    expect(validateCrossCourseAlignment(mapping, resolved).success).toBe(true);
    for (const status of ['not-reviewed', 'unmatched'] as const) {
      mapping.outcome = { status };
      expect(validateCrossCourseAlignment(mapping, resolved).success).toBe(true);
    }
  });
});
