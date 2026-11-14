import { APICallError } from 'ai';
import { describe, expect, test } from 'vitest';
import { getGlobalModelConfig } from '../../src/config/modelConfig.js';
import {
  CourseExercisesStateSchema,
  CourseYoutubeQueryPlanSchema,
} from '../../src/workflows/courseGenerationWorkflowContract.js';
import {
  createWorkflowModelDiagnostic,
  readWorkflowErrorDiagnostic,
  readWorkflowModelDiagnostic,
  toWorkflowErrorDiagnostic,
} from '../../src/workflows/workflowErrorDiagnostics.js';

describe('workflow error diagnostics', () => {
  test('preserves sanitized cause class, code and stage through a provider wrapper and log readback', () => {
    const cause = Object.assign(new Error('PRIVATE_OUTPUT'), {
      name: 'CodexAppServerError',
      code: 'timeout',
      stage: 'turn-start',
    });
    const error = new Error('PRIVATE_PROMPT', { cause });
    error.name = 'CourseModelProviderError';
    const durable = toWorkflowErrorDiagnostic(error, { includeContent: false });
    expect(durable).toEqual({
      type: 'CourseModelProviderError',
      cause: { type: 'CodexAppServerError', code: 'timeout', errorStage: 'turn-start' },
    });
    expect(readWorkflowErrorDiagnostic(JSON.parse(JSON.stringify(durable)))).toEqual(durable);
  });
  test('retains thrown strings as redacted original diagnostics', () => {
    expect(toWorkflowErrorDiagnostic('Codex failed: api_key=hidden')).toEqual({
      originalMessage: 'Codex failed: api_key=[REDACTED]',
      type: 'UnknownError',
    });
  });
  test('keeps only a trusted stage message with bounded technical identifiers, status, and cause', () => {
    const providerError = Object.assign(new Error('private response body'), {
      code: 'invalid_request',
      responseBody: 'private response body with provider-secret',
      status: 400,
    });
    const outer = Object.assign(new Error('private prompt', { cause: providerError }), {
      code: 'lesson_provider_failed',
      name: 'ProviderTransientError',
    });

    const diagnostic = toWorkflowErrorDiagnostic(outer, {
      trustedMessage: 'Lesson research failed. api_key=private-key',
    });

    expect(diagnostic).toEqual({
      cause: {
        code: 'invalid_request',
        originalMessage: 'private response body',
        status: 400,
        type: 'Error',
      },
      code: 'lesson_provider_failed',
      message: 'Lesson research failed. api_key=[REDACTED]',
      originalMessage: 'private prompt',
      type: 'ProviderTransientError',
    });
    expect(JSON.stringify(diagnostic)).toContain('private prompt');
    expect(JSON.stringify(diagnostic)).toContain('private response body');
    expect(JSON.stringify(diagnostic)).not.toContain('private-key');
    expect(JSON.stringify(diagnostic)).not.toContain('provider-secret');
    expect(JSON.stringify(diagnostic)).not.toContain('responseBody');
  });

  test('retains redacted provider error details without retaining request payloads', () => {
    const providerError = new APICallError({
      data: {
        error: {
          code: 400,
          message: 'PRIVATE_LESSON_MARKER',
          metadata: {
            error_type: 'invalid_request',
            provider_error_code: 'reasoning_required',
          },
          param: 'reasoning',
        },
      },
      message: 'Provider rejected schema. api_key=private-key',
      requestBodyValues: { prompt: 'private lesson prompt' },
      responseBody:
        '{"error":{"message":"upstream rejected request","api_key":"private-response-key","authorization":"Bearer private-response-token"}}',
      statusCode: 400,
      url: 'https://openrouter.ai/api/v1/chat/completions?token=private-token',
    });

    expect(
      toWorkflowErrorDiagnostic(new Error('private outer message', { cause: providerError }))
    ).toEqual({
      cause: {
        code: 400,
        message: 'Provider error: invalid_request.',
        originalMessage: 'Provider rejected schema. api_key=[REDACTED]',
        parameter: 'reasoning',
        providerCode: 'reasoning_required',
        providerErrorType: 'invalid_request',
        providerResponse:
          '{"error":{"message":"upstream rejected request","api_key":"[REDACTED]","authorization":"[REDACTED]"}}',
        status: 400,
        type: 'AI_APICallError',
      },
      originalMessage: 'private outer message',
      type: 'Error',
    });
    expect(
      toWorkflowErrorDiagnostic(new Error('private outer message', { cause: providerError }), {
        includeContent: false,
      })
    ).toEqual({
      cause: {
        code: 400,
        parameter: 'reasoning',
        providerCode: 'reasoning_required',
        providerErrorType: 'invalid_request',
        status: 400,
        type: 'AI_APICallError',
      },
      type: 'Error',
    });
    const serialized = JSON.stringify(toWorkflowErrorDiagnostic(providerError));
    expect(serialized).not.toContain('private lesson prompt');
    expect(serialized).toContain('upstream rejected request');
    expect(serialized).not.toContain('private-response-key');
    expect(serialized).not.toContain('private-response-token');
    expect(serialized).not.toContain('private-token');
    expect(serialized).not.toContain('private-key');
    expect(serialized).not.toContain('PRIVATE_LESSON_MARKER');
  });

  test('rejects arbitrary persisted fields instead of forwarding them to logs', () => {
    expect(
      readWorkflowErrorDiagnostic({
        code: 'provider_failed',
        message: 'Lesson research failed.',
        type: 'AI_APICallError',
      })
    ).toEqual({
      code: 'provider_failed',
      message: 'Lesson research failed.',
      type: 'AI_APICallError',
    });
    expect(readWorkflowErrorDiagnostic({ type: 'private prompt with spaces' })).toBeUndefined();
    expect(
      readWorkflowErrorDiagnostic({
        cause: {
          message: 'PRIVATE_LESSON_MARKER',
          originalMessage: 'Codex rejected the schema. password=hidden',
          providerCode: 'reasoning_required',
          providerErrorType: 'invalid_request',
          type: 'AI_APICallError',
        },
        message: 'Lesson research failed.',
        type: 'ProviderTransientError',
      })
    ).toEqual({
      cause: {
        message: 'Provider error: invalid_request.',
        originalMessage: 'Codex rejected the schema. password=[REDACTED]',
        providerCode: 'reasoning_required',
        providerErrorType: 'invalid_request',
        type: 'AI_APICallError',
      },
      message: 'Lesson research failed.',
      type: 'ProviderTransientError',
    });
  });

  test('projects only the effective model routing fields', () => {
    const config = {
      ...getGlobalModelConfig(),
      aiProvider: 'openrouter' as const,
      aiProviderOverrides: { lesson: 'codex' as const },
      codexFastModelSlots: ['lesson' as const],
      codexLessonModel: 'gpt-5.6-terra',
    };

    expect(createWorkflowModelDiagnostic(config, 'lesson')).toEqual({
      model: 'gpt-5.6-terra',
      provider: 'codex',
      serviceTier: 'fast',
      slot: 'lesson',
    });
    expect(
      readWorkflowModelDiagnostic({
        apiKey: 'private-key',
        model: 'gpt-5.6-terra',
        provider: 'codex',
        serviceTier: 'fast',
        slot: 'lesson',
      })
    ).toEqual({
      model: 'gpt-5.6-terra',
      provider: 'codex',
      serviceTier: 'fast',
      slot: 'lesson',
    });
    expect(
      readWorkflowModelDiagnostic({
        model: 'private model with spaces',
        provider: 'codex',
        slot: 'lesson',
      })
    ).toBeUndefined();
  });
});

test('keeps caller stage separate from the underlying error stage', () => {
  const error = Object.assign(new Error('private'), { stage: 'pdf-parse' });
  const diagnostic = {
    stage: 'source-preparation',
    ...toWorkflowErrorDiagnostic(error, { includeContent: false }),
  };
  expect(diagnostic).toEqual({
    stage: 'source-preparation',
    errorStage: 'pdf-parse',
    type: 'Error',
  });
});

test('durable planning fallback schemas preserve phase timings and nested error stages', () => {
  const modelCall = {
    phase: 'awaiting-ack',
    elapsedMs: 25,
    phaseElapsedMs: 20,
    durationsMs: { initializing: 5, 'awaiting-ack': 20 },
  };
  const projected = toWorkflowErrorDiagnostic(
    Object.assign(
      new Error('PRIVATE_PROMPT', {
        cause: Object.assign(new Error('PRIVATE_OUTPUT'), { stage: 'turn/start', code: 'timeout' }),
      }),
      { modelCall }
    ),
    { includeContent: false }
  );
  const youtube = CourseYoutubeQueryPlanSchema.parse({
    queries: ['synthetic query'],
    planningDiagnostic: projected,
  });
  const exercise = CourseExercisesStateSchema.shape.exercisePlanningDiagnostic.parse(projected);
  for (const checkpoint of [youtube.planningDiagnostic, exercise]) {
    const logged = readWorkflowErrorDiagnostic(JSON.parse(JSON.stringify(checkpoint)));
    expect(logged).toEqual(projected);
    expect(logged).toMatchObject({
      modelCall,
      cause: { errorStage: 'turn/start', code: 'timeout' },
    });
    expect(JSON.stringify(logged)).not.toContain('PRIVATE_');
  }
});
