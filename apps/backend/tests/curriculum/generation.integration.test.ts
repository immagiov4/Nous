import { describe, expect, test, vi } from 'vitest';
import { getGlobalModelConfig } from '../../src/config/modelConfig.js';
import { createCourseObjectGenerator } from '../../src/workflows/courseGenerationModel.js';
import { crossCourseFixture, curriculumFixture, diagnosticFixture } from './fixtures';
import { CurriculumGenerationProbeSchema, runCurriculumGenerationProbe } from './generationHarness';

function integrationFixture() {
  const { curriculum, resolved: curriculumContext } = curriculumFixture();
  const diagnostic = diagnosticFixture();
  const crossCourse = crossCourseFixture();
  return {
    response: {
      curriculum,
      diagnosticMappings: [diagnostic.mapping],
      crossCourseAlignments: [crossCourse.mapping],
    },
    input: {
      config: {
        ...getGlobalModelConfig(),
        aiProvider: 'codex' as const,
        aiProviderOverrides: { course: 'codex' as const },
      },
      prompt:
        'Plan polynomial rates and their application to one-dimensional motion. The learner calculated one derivative with a hint, but their self-report claims autonomy. Keep these sources separate.',
      signal: new AbortController().signal,
      curriculumContext,
      diagnosticContext: diagnostic.resolved,
      sourceCurriculum: crossCourse.resolved.source,
    },
  };
}

describe('curriculum generation adapter integration', () => {
  test.each([
    'diagnosticMappings',
    'crossCourseAlignments',
  ] as const)('rejects duplicate mapping identities in %s before using their outcomes', async field => {
    const { input, response } = integrationFixture();
    const duplicated = {
      ...response,
      [field]: [...response[field], { ...response[field][0], outcome: { status: 'unmatched' } }],
    };
    const generate = createCourseObjectGenerator({
      runAiObject: vi.fn(),
      runCodexObject: vi.fn().mockResolvedValue(JSON.stringify(duplicated)),
    });
    await expect(runCurriculumGenerationProbe({ ...input, generate })).rejects.toMatchObject({
      failure: { kind: 'corrective', code: 'course_model_output_invalid' },
    });
  });
  test('passes a synthetic course and both mappings through production schema conversion, JSON parsing and reference validation', async () => {
    const { input, response } = integrationFixture();
    const runCodexObject = vi.fn().mockResolvedValue(JSON.stringify(response));
    const generate = createCourseObjectGenerator({ runAiObject: vi.fn(), runCodexObject });
    const result = await runCurriculumGenerationProbe({ ...input, generate });
    expect(result.success && result.generated).toEqual(response);
    expect(runCodexObject).toHaveBeenCalledWith(
      expect.objectContaining({
        allowWebSearch: false,
        outputSchema: expect.objectContaining({ type: 'object' }),
      })
    );
  });

  test('rejects an invented reference accepted by the provider JSON shape', async () => {
    const { input, response } = integrationFixture();
    response.curriculum.activityTargets[0].objectiveId = 'invented-objective';
    expect(CurriculumGenerationProbeSchema.safeParse(response).success).toBe(true);
    const generate = createCourseObjectGenerator({
      runAiObject: vi.fn(),
      runCodexObject: vi.fn().mockResolvedValue(JSON.stringify(response)),
    });
    const result = await runCurriculumGenerationProbe({ ...input, generate });
    expect(result).toMatchObject({ success: false, stage: 'curriculum' });
  });

  test('rejects a valid-shaped diagnostic claim tied to another attempt', async () => {
    const { input, response } = integrationFixture();
    const source = response.diagnosticMappings[0].source;
    if (source.kind !== 'observation') throw new Error('Fixture requires an observation');
    source.attemptId = 'another-attempt';
    const generate = createCourseObjectGenerator({
      runAiObject: vi.fn(),
      runCodexObject: vi.fn().mockResolvedValue(JSON.stringify(response)),
    });
    expect(await runCurriculumGenerationProbe({ ...input, generate })).toMatchObject({
      success: false,
      stage: 'mappings',
    });
  });

  test('preserves ambiguous mappings through the non-Codex provider path too', async () => {
    const { input, response } = integrationFixture();
    const outcome = response.diagnosticMappings[0].outcome;
    if (outcome.status !== 'matched') throw new Error('Fixture requires a match');
    response.diagnosticMappings[0].outcome = {
      status: 'ambiguous',
      alternatives: [
        outcome.targets,
        [
          {
            target: {
              kind: 'objective',
              curriculum: response.curriculum.ref,
              objectiveId: 'calculate-rate',
            },
            scope: 'Justification of the local calculation',
            reason: 'The explanation might address the objective criterion.',
          },
        ],
      ],
    };
    const generate = createCourseObjectGenerator({
      runAiObject: vi.fn().mockResolvedValue(response),
      runCodexObject: vi.fn(),
    });
    const config = {
      ...input.config,
      aiProvider: 'openai' as const,
      aiProviderOverrides: { course: 'openai' as const },
    };
    const result = await runCurriculumGenerationProbe({ ...input, config, generate });
    expect(result.success && result.generated.diagnosticMappings[0].outcome).toEqual(
      response.diagnosticMappings[0].outcome
    );
  });
});
