import { APICallError } from 'ai';
import { describe, expect, test } from 'vitest';
import { getGlobalModelConfig } from '../../src/config/modelConfig.js';
import {
  createWorkflowModelDiagnostic,
  readWorkflowErrorDiagnostic,
  readWorkflowModelDiagnostic,
  toWorkflowErrorDiagnostic,
} from '../../src/workflows/workflowErrorDiagnostics.js';

describe('workflow error diagnostics', () => {
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
        status: 400,
        type: 'Error',
      },
      code: 'lesson_provider_failed',
      message: 'Lesson research failed. api_key=[REDACTED]',
      type: 'ProviderTransientError',
    });
    expect(JSON.stringify(diagnostic)).not.toContain('private prompt');
    expect(JSON.stringify(diagnostic)).not.toContain('private response body');
    expect(JSON.stringify(diagnostic)).not.toContain('private-key');
    expect(JSON.stringify(diagnostic)).not.toContain('provider-secret');
    expect(JSON.stringify(diagnostic)).not.toContain('responseBody');
  });

  test('projects typed provider fields without retaining its free-text message or payloads', () => {
    const providerError = new APICallError({
      data: {
        error: {
          code: 400,
          message: 'PRIVATE_LESSON_MARKER',
          metadata: {
            error_type: 'invalid_request',
            provider_code: 'reasoning_required',
          },
          param: 'reasoning',
        },
      },
      message: 'PRIVATE_LESSON_MARKER api_key=private-key',
      requestBodyValues: { prompt: 'private lesson prompt' },
      responseBody: 'private provider response',
      statusCode: 400,
      url: 'https://openrouter.ai/api/v1/chat/completions?token=private-token',
    });

    expect(
      toWorkflowErrorDiagnostic(new Error('private outer message', { cause: providerError }))
    ).toEqual({
      cause: {
        code: 400,
        message: 'Provider error: invalid_request.',
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
    expect(serialized).not.toContain('private provider response');
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
