import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import * as z from 'zod';
import { getGlobalModelConfig } from '../../src/config/modelConfig.js';
import { REVIEW_DIAGNOSTIC_ID_LIMIT } from '../../src/services/lessonGenerationCorrection.js';
import { reviewLessonContentDraftStrict } from '../../src/services/lessonGenerationModel.js';
import type {
  LessonContentDraft,
  LessonGenerationInput,
} from '../../src/services/lessonGenerationTypes.js';
import { verifyLessonContentDraft } from '../../src/services/lessonGenerationVerification.js';
import { runWithWorkflowAttemptMetering } from '../../src/workflows/workflowAiMetering.js';

const { generateStructuredOutput } = vi.hoisted(() => ({ generateStructuredOutput: vi.fn() }));
vi.mock('../../src/services/structuredGeneration.js', () => ({ generateStructuredOutput }));
vi.mock('../../src/services/mermaidValidation.js', () => ({
  classifyMermaidInputs: vi.fn(async (codes: string[]) => codes.map(() => false)),
}));

const input: LessonGenerationInput = {
  config: getGlobalModelConfig(),
  description: 'Explain assembly registers.',
  imageCandidates: [],
  instructionPacks: [],
  language: 'English',
  pedagogicalContext: '',
  previousLessonTitles: [],
  refreshResearch: false,
  researchContext: '',
  sectionTitle: 'Registers',
  signal: new AbortController().signal,
  sourceContext: '',
  sources: [],
};
const draft: LessonContentDraft = {
  contentBlocks: [
    {
      type: 'markdown',
      markdown:
        'Registers hold operands.\n\n```mips\naddi $t0, $zero, 1\n```\n\n```asm\nmov eax, 1\n```\n\n```text\nregister t0: 1\n```',
    },
  ],
  generatedVisuals: [],
  imageRefs: [],
};
const review = (candidate = draft) =>
  verifyLessonContentDraft({
    draft: candidate,
    generationInput: input,
    responseSchema: { name: 'synthetic', schema: { properties: {}, required: [] } },
  });
const preserved = { preserved: true, evidence: 'Registers and operands remain explained.' };

beforeEach(() => {
  generateStructuredOutput.mockReset();
});
afterEach(() => {
  vi.restoreAllMocks();
});

const acceptedReview = (
  output: {
    schema: { properties: { verificationReport: { properties: Record<string, unknown> } } };
  },
  candidate = draft
) => ({
  ...candidate,
  lessonIntegrity: { topic: preserved, objectives: preserved },
  verificationReport: Object.fromEntries(
    Object.keys(output.schema.properties.verificationReport.properties).map(id => [
      id,
      { status: 'pass', evidence: 'Reviewed registers.', action: '' },
    ])
  ),
});

test('classifies a rewritten candidate by server IDs, excluding tagged mips and asm fences', async () => {
  const log = vi.spyOn(console, 'info').mockImplementation(() => {});
  const corrected = structuredClone(draft);
  corrected.contentBlocks.push({ type: 'markdown', markdown: '```plaintext\nregister t1: 2\n```' });
  generateStructuredOutput.mockImplementation(async ({ output, config, signal, prompt }) => {
    expect(config).toBe(input.config);
    expect(signal).toBe(input.signal);
    if (output.name === 'durable_lesson_fence_classification') {
      const ids = Object.keys(output.schema.properties);
      expect(ids).toHaveLength(2);
      expect(JSON.parse(prompt).fences).toEqual([
        { id: ids[0], source: '```text\nregister t0: 1\n```' },
        { id: ids[1], source: '```plaintext\nregister t1: 2\n```' },
      ]);
      const validate = z.fromJSONSchema(output.schema);
      expect(validate.safeParse({ [ids[0]]: 'code' }).success).toBe(false);
      expect(
        validate.safeParse(Object.fromEntries([...ids, 'unknown'].map(id => [id, 'code']))).success
      ).toBe(false);
      expect(output.schema.required).toEqual(ids);
      expect(output.schema.additionalProperties).toBe(false);
      return Object.fromEntries(ids.map(id => [id, 'code']));
    }
    const report = output.schema.properties.verificationReport;

    return {
      ...corrected,
      lessonIntegrity: { topic: preserved, objectives: preserved },
      verificationReport: Object.fromEntries(
        Object.keys(report.properties).map(id => [
          id,
          { status: 'pass', evidence: 'Reviewed registers.', action: '' },
        ])
      ),
    };
  });
  await expect(review()).resolves.toEqual(corrected);
  expect(generateStructuredOutput).toHaveBeenCalledTimes(2);
  expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({
    ran: true,
    fenceCount: 2,
    durationMs: expect.any(Number),
    outcome: 'succeeded',
  });
});

test('forbidden not-applicable cannot pass the structured report schema', async () => {
  generateStructuredOutput.mockImplementation(async ({ output }) => {
    const report = output.schema.properties.verificationReport;
    const ids = Object.keys(report.properties);
    const valid = Object.fromEntries(
      ids.map(id => [id, { status: 'pass', evidence: 'Reviewed registers.', action: '' }])
    );
    expect(z.fromJSONSchema(report).safeParse(valid).success).toBe(true);
    const invalid = {
      ...valid,
      'core.clarity': { status: 'not-applicable', evidence: 'Skipped.', action: '' },
    };
    expect(z.fromJSONSchema(report).safeParse(invalid).success).toBe(false);
    return {
      ...draft,
      lessonIntegrity: { topic: preserved, objectives: preserved },
      verificationReport: invalid,
    };
  });
  await expect(review()).rejects.toMatchObject({
    code: 'lesson_review_report_incomplete',
    feedback: expect.stringContaining('core.clarity'),
  });
});

test('reports a skipped classifier for tagged-only lessons without another provider request', async () => {
  const log = vi.spyOn(console, 'info').mockImplementation(() => {});
  const tagged = {
    ...draft,
    contentBlocks: [
      {
        type: 'markdown' as const,
        markdown: '```mips\naddi $t0, $zero, 1\n```\n\n```asm\nmov eax, 1\n```',
      },
    ],
  };
  generateStructuredOutput.mockImplementation(async ({ output }) => acceptedReview(output, tagged));
  await runWithWorkflowAttemptMetering(
    { runId: 'run-1', nodeInstanceId: 'node-1', attemptNumber: 2, record: async () => {} },
    () => review(tagged)
  );
  expect(generateStructuredOutput).toHaveBeenCalledOnce();
  const event = JSON.parse(log.mock.calls[0][0]);
  expect(event).toMatchObject({
    event: 'workflow.lesson-fence-classification',
    runId: 'run-1',
    attemptNumber: 2,
    ran: false,
    fenceCount: 0,
    outcome: 'skipped',
    durationMs: expect.any(Number),
  });
  expect(event).not.toHaveProperty('nodeInstanceId');
  expect(JSON.stringify(event)).not.toContain('addi');
});

test.each([
  'prose',
  'malformed',
  'aborted',
])('classifier %s prevents review checkpoint acceptance without internal retries', async kind => {
  const controller = new AbortController();
  const log = vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  generateStructuredOutput.mockImplementation(async ({ output, signal }) => {
    expect(signal).toBe(controller.signal);
    if (output.name !== 'durable_lesson_fence_classification') return acceptedReview(output);
    if (kind === 'aborted') {
      controller.abort(new Error('Stopped'));
      throw controller.signal.reason;
    }
    if (kind === 'malformed') throw new SyntaxError('PRIVATE_RAW_RESPONSE');
    return { 'fence-0': 'prose' };
  });
  let checkpointAccepted = false;
  const operation = reviewLessonContentDraftStrict({
    draft,
    generationInput: { ...input, signal: controller.signal },
    checkpointReview: async work => {
      const candidate = await work();
      checkpointAccepted = true;
      return candidate;
    },
  });
  if (kind === 'aborted') await expect(operation).rejects.toThrow('Stopped');
  else await expect(operation).rejects.toMatchObject({ code: 'lesson_review_fenced_prose' });
  expect(checkpointAccepted).toBe(false);
  expect(generateStructuredOutput).toHaveBeenCalledTimes(2);
  const logCalls = [...log.mock.calls, ...vi.mocked(console.warn).mock.calls];
  expect(logCalls.map(([entry]) => JSON.parse(entry))).toContainEqual(
    expect.objectContaining({
      ran: true,
      fenceCount: 1,
      outcome: kind === 'aborted' ? 'interrupted' : 'failed',
      durationMs: expect.any(Number),
    })
  );
  expect(JSON.stringify(logCalls)).not.toContain('PRIVATE_');
});

test('report schema excludes duplicates, missing identities and not-applicable on existing quizzes', async () => {
  const quizDraft = {
    ...draft,
    contentBlocks: [
      ...draft.contentBlocks,
      {
        type: 'inline-quiz' as const,
        quiz: {
          question: 'Which register?',
          options: ['t0', 't1'],
          correctIndex: 0,
          exerciseType: 'concept-check',
        },
      },
    ],
  };
  generateStructuredOutput.mockImplementation(async ({ output }) => {
    const result = acceptedReview(output, quizDraft);
    const report = result.verificationReport;
    const schema = z.fromJSONSchema(output.schema.properties.verificationReport);
    expect(schema.safeParse(report).success).toBe(true);
    expect(
      schema.safeParse([
        { checkId: 'core.clarity', ...report['core.clarity'] },
        { checkId: 'core.clarity', ...report['core.clarity'] },
      ]).success
    ).toBe(false);
    const { 'core.clarity': _missing, ...incomplete } = report;
    expect(schema.safeParse(incomplete).success).toBe(false);
    report['quiz-quality'].status = 'not-applicable';
    expect(schema.safeParse(report).success).toBe(false);
    return result;
  });
  await expect(review(quizDraft)).rejects.toMatchObject({
    code: 'lesson_review_report_incomplete',
    feedback: expect.stringContaining('quiz-quality'),
  });
});

test('ID mismatch diagnostics retain full counts and bounded IDs without echoing unknown keys', async () => {
  const count = REVIEW_DIAGNOSTIC_ID_LIMIT + 1;
  const candidate = {
    ...draft,
    contentBlocks: [
      {
        type: 'markdown' as const,
        markdown: Array.from({ length: count }, () => '```text\nregister t0: 1\n```').join('\n\n'),
      },
    ],
  };
  generateStructuredOutput.mockImplementation(async ({ output }) =>
    output.name === 'durable_lesson_fence_classification'
      ? { PRIVATE_FENCE_SENTINEL: 'code', 'fence-999': 'code' }
      : acceptedReview(output, candidate)
  );
  const error = await review(candidate).catch(error => error);
  expect(error).toMatchObject({
    code: 'lesson_review_fenced_prose',
    validation: {
      reason: 'id-mismatch',
      expectedCount: count,
      receivedCount: 2,
      unknownIdCount: 2,
      receivedIds: ['fence-999'],
    },
  });
  expect(error.validation.expectedIds).toHaveLength(REVIEW_DIAGNOSTIC_ID_LIMIT);
  expect(error.feedback).toContain('Missing fence IDs: fence-0');
  expect(error.feedback).not.toContain('PRIVATE_');
  expect(error.feedback).not.toContain('register t0');
});
