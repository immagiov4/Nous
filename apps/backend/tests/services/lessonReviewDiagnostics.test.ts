import { describe, expect, test, vi } from 'vitest';
import { getGlobalModelConfig } from '../../src/config/modelConfig.js';
import { verifyLessonContentDraft } from '../../src/services/lessonGenerationVerification.js';
import {
  createLessonGenerationStageServices,
  type LessonGenerationStageDependencies,
} from '../../src/workflows/lessonGenerationStageServices.js';
import { LessonDraftStateSchema } from '../../src/workflows/lessonGenerationWorkflowContract.js';
import { readLessonReviewRetry } from '../../src/workflows/lessonReviewCheckpoint.js';
import { parseStepFailure, toStepFailure } from '../../src/workflows/retryPolicy.js';
import {
  readWorkflowErrorDiagnostic,
  toWorkflowErrorDiagnostic,
} from '../../src/workflows/workflowErrorDiagnostics.js';

const { generateStructuredOutput, classifyMermaidInputs } = vi.hoisted(() => ({
  generateStructuredOutput: vi.fn(),
  classifyMermaidInputs: vi.fn(async () => [false]),
}));
vi.mock('../../src/services/structuredGeneration.js', () => ({ generateStructuredOutput }));
vi.mock('../../src/services/mermaidValidation.js', () => ({ classifyMermaidInputs }));

// All text is synthetic. Real verification, schemas, Markdown parser and error factory run.
const draft = {
  contentBlocks: [
    { type: 'markdown' as const, markdown: 'A synthetic counter.\n\n```\ncount = 1\n```' },
  ],
  generatedVisuals: [],
  imageRefs: [],
};
const generationInput = {
  config: { ...getGlobalModelConfig(), aiProvider: 'codex' as const, aiProviderOverrides: {} },
  description: 'Explain a synthetic counter.',
  imageCandidates: [],
  instructionPacks: [],
  language: 'English',
  pedagogicalContext: '',
  previousLessonTitles: [],
  refreshResearch: false,
  researchContext: '',
  sectionTitle: 'Synthetic counter',
  signal: new AbortController().signal,
  sourceContext: '',
  sources: [],
};

describe('sanitized review rejection diagnostics', () => {
  test.each([
    'valid',
    'missing',
    'count',
    'source',
    'prose',
    'report-duplicate',
    'report-action',
    'report-applicability',
    'schema-source',
    'schema-kind',
    'report-schema',
    'report-key',
    'report-missing',
    'report-unknown',
    'report-evidence',
    'report-judgment',
  ])('%s', async variant => {
    let returningValid = false;
    generateStructuredOutput.mockImplementation(async ({ output }) => {
      const ids: string[] =
        output.schema.properties.verificationReport.items.properties.checkId.enum;
      const response = {
        ...structuredClone(draft),
        fencedCode: [{ source: '```\ncount = 1\n```', kind: 'code' }],
        lessonIntegrity: {
          topic: { preserved: true, evidence: 'Synthetic topic preserved.' },
          objectives: { preserved: true, evidence: 'Synthetic objective preserved.' },
        },
        verificationReport: ids.map(checkId => ({
          checkId,
          status: 'pass',
          evidence: 'Synthetic evidence.',
          action: 'Retain.',
        })),
      };
      if (!returningValid && variant === 'missing')
        Object.assign(response, { fencedCode: undefined });
      if (!returningValid && variant === 'count') response.fencedCode = [];
      if (!returningValid && variant === 'source')
        response.fencedCode[0].source = '```\ncount = 2\n```';
      if (!returningValid && variant === 'prose') response.fencedCode[0].kind = 'prose';
      if (!returningValid && variant === 'report-duplicate')
        response.verificationReport[1].checkId = ids[0];
      if (!returningValid && variant === 'report-action')
        Object.assign(response.verificationReport[0], { status: 'corrected', action: '' });
      if (!returningValid && variant === 'report-applicability')
        Object.assign(response.verificationReport[0], { status: 'not-applicable' });
      if (!returningValid && variant === 'schema-source')
        Object.assign(response.fencedCode[0], { source: 42 });
      if (!returningValid && variant === 'schema-kind')
        response.fencedCode[0].kind = 'PRIVATE_KIND_SENTINEL';
      if (!returningValid && variant === 'report-schema')
        Object.assign(response.verificationReport[0], {
          status: 'PRIVATE_STATUS_SENTINEL',
          PRIVATE_KEY_SENTINEL: 'PRIVATE_VALUE_SENTINEL',
        });
      if (!returningValid && variant === 'report-key')
        Object.assign(response.verificationReport[0], {
          PRIVATE_KEY_SENTINEL: 'PRIVATE_VALUE_SENTINEL',
        });
      if (!returningValid && variant === 'report-missing') response.verificationReport.shift();
      if (!returningValid && variant === 'report-unknown')
        response.verificationReport[0].checkId = 'PRIVATE_CHECK_SENTINEL';
      if (!returningValid && variant === 'report-evidence')
        response.verificationReport[0].evidence = '  ';
      if (!returningValid && variant === 'report-judgment') {
        response.contentBlocks.push({
          type: 'inline-quiz',
          quiz: {
            correctIndex: 0,
            exerciseType: 'concept-check',
            explanation: 'Synthetic.',
            question: 'Synthetic?',
            options: ['One', 'Two'],
          },
        } as never);
        Object.assign(response.verificationReport[ids.indexOf('quiz-quality')], {
          status: 'not-applicable',
        });
      }
      return response;
    });
    const result = verifyLessonContentDraft({
      draft,
      generationInput,
      responseSchema: { name: 'synthetic', schema: { properties: {}, required: [] } },
    });
    if (!returningValid && variant === 'valid') {
      await expect(result).resolves.toEqual(draft);
      return;
    }
    const error = await result.then(
      () => {
        throw new Error('Expected rejection');
      },
      error => error
    );
    const family = variant.startsWith('report-') ? 'report' : 'fence';
    expect(error.code).toBe(
      family === 'report' ? 'lesson_review_report_incomplete' : 'lesson_review_fenced_prose'
    );
    expect(typeof error.feedback).toBe('string');
    const expected = {
      'schema-source': { reason: 'schema-invalid', path: ['fencedCode', 0, 'source'] },
      'schema-kind': { reason: 'schema-invalid', path: ['fencedCode', 0, 'kind'] },
      'report-key': { reason: 'schema-invalid', path: ['verificationReport', 0] },
      'report-schema': { reason: 'schema-invalid', path: ['verificationReport', 0, 'status'] },
      'report-missing': {
        reason: 'missing-check',
        path: ['verificationReport'],
        requiredCheckIndex: 0,
      },
      'report-unknown': { reason: 'unknown-check', path: ['verificationReport', 0, 'checkId'] },
      'report-evidence': { reason: 'schema-invalid', path: ['verificationReport', 0, 'evidence'] },
      'report-judgment': {
        reason: 'judgment-required',
        path: ['verificationReport', 13, 'status'],
      },
      missing: { reason: 'schema-invalid', path: ['fencedCode'] },
      count: { reason: 'count-mismatch', path: ['fencedCode'] },
      source: { reason: 'source-mismatch', path: ['fencedCode', 0, 'source'] },
      prose: { reason: 'prose-remains', path: ['fencedCode', 0, 'kind'] },
      'report-duplicate': { reason: 'duplicate-check', path: ['verificationReport', 1, 'checkId'] },
      'report-action': { reason: 'action-missing', path: ['verificationReport', 0, 'action'] },
      'report-applicability': {
        reason: 'not-applicable-forbidden',
        path: ['verificationReport', 0, 'status'],
      },
    }[variant];
    expect(error.validation).toEqual(expected);
    expect(JSON.parse(error.feedback.split('Rejected contract: ')[1])).toEqual(expected);
    const reviewContent = vi
      .fn()
      .mockRejectedValueOnce(error)
      .mockImplementationOnce(async ({ draft, generationInput }) =>
        verifyLessonContentDraft({
          draft,
          generationInput,
          responseSchema: { name: 'synthetic', schema: { properties: {}, required: [] } },
        })
      );
    const services = createLessonGenerationStageServices({
      reviewContent,
    } as unknown as LessonGenerationStageDependencies);
    const input = LessonDraftStateSchema.parse({
      draft,
      stage: 'draft',
      discoveredYoutubeSources: [],
      documentAssetOwners: [],
      documentSourceHash: null,
      existingDossierJson: null,
      existingSources: [],
      originalSources: [],
      pdfImages: [],
      lessonSources: [],
      lessonInputData: { ...generationInput, sourceContext: 'PRIVATE_SOURCE_SENTINEL' },
      request: {
        forceRegenerate: true,
        projectId: 'project-1',
        sectionId: 'lesson-1',
        userId: 'user-1',
      },
      requiresCoverageAssessment: false,
      research: { context: '', summary: null, youtube: null },
      sourceFingerprint: 'a'.repeat(64),
      targetFingerprint: 'b'.repeat(64),
      warnings: [],
      youtubePlanning: { courseTitle: '', keyConcepts: [] },
    });
    const context = {
      input,
      attemptNumber: 1,
      config: { models: generationInput.config },
      signal: generationInput.signal,
      execution: { nodeInstanceId: 'node-1', runId: 'run-1' },
      idempotencyKey: 'step-1',
      retryFeedback: '',
      providerEffect: {
        run: async ({ operation }: { operation: () => Promise<unknown> }) => operation(),
      },
    };
    const stageError = await services.reviewLesson(context as never).catch(error => error);
    const failure = parseStepFailure(JSON.parse(JSON.stringify(toStepFailure(stageError))));
    expect(failure).toMatchObject({
      kind: 'corrective',
      details: { diagnostic: { validation: expected } },
    });
    const diagnostic = failure.details?.diagnostic;
    expect(readWorkflowErrorDiagnostic(diagnostic)).toMatchObject({ validation: expected });
    expect(toWorkflowErrorDiagnostic(error, { includeContent: false })).toMatchObject({
      validation: expected,
    });
    if (failure.kind !== 'corrective') throw new Error('Expected corrective failure');
    expect(readLessonReviewRetry(failure.feedback)).toMatchObject({
      pedagogicalRevision: 0,
      feedback: error.feedback,
    });
    returningValid = true;
    await expect(
      services.reviewLesson({
        ...context,
        attemptNumber: 2,
        retryFeedback: failure.feedback,
      } as never)
    ).resolves.toMatchObject({ draft });
    expect(reviewContent.mock.calls[1][0].generationInput.retryFeedback).toBe(error.feedback);
    expect(JSON.stringify(failure)).not.toContain('PRIVATE_');
    expect(JSON.stringify(failure)).not.toContain('count =');
    expect(JSON.stringify(failure)).not.toContain('Synthetic evidence.');
  });
});

test('revalidates persisted diagnostic metadata without retaining unknown keys or values', () => {
  const validation = { reason: 'source-mismatch', path: ['fencedCode', 2, 'source'] };
  const restored = readWorkflowErrorDiagnostic({
    type: 'LessonGenerationCorrectionError',
    validation: { ...validation, source: 'PRIVATE_RAW_SENTINEL' },
  });
  expect(restored).toEqual({ type: 'LessonGenerationCorrectionError', validation });
  for (const unsafe of [
    { reason: 'PRIVATE_REASON_SENTINEL', path: ['fencedCode'] },
    { reason: 'schema-invalid', path: ['verificationReport', 0, 'PRIVATE_KEY_SENTINEL'] },
    { reason: 'schema-invalid', path: ['fencedCode', -1] },
  ]) {
    expect(readWorkflowErrorDiagnostic({ type: 'Error', validation: unsafe })).toEqual({
      type: 'Error',
    });
  }
});
