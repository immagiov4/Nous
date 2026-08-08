import { NoObjectGeneratedError } from 'ai';
import { describe, expect, test, vi } from 'vitest';
import * as z from 'zod';

import { getGlobalModelConfig } from '../../src/config/modelConfig.js';
import { createCourseObjectGenerator } from '../../src/workflows/courseGenerationModel.js';

const schema = z.object({ title: z.string().min(1) }).strict();

describe('course generation structured model adapter', () => {
  test('routes Codex through the app server and validates its JSON output', async () => {
    const signal = new AbortController().signal;
    const runAiObject = vi.fn();
    const runCodexObject = vi.fn().mockResolvedValue('{"title":"Corso"}');
    const generate = createCourseObjectGenerator({ runAiObject, runCodexObject });
    const config = {
      ...getGlobalModelConfig(),
      aiProvider: 'codex' as const,
      aiProviderOverrides: { course: 'codex' as const },
    };

    const result = await generate({
      config,
      developerInstructions: 'Restituisci il corso.',
      name: 'course_plan',
      prompt: 'Crea il corso.',
      schema,
      signal,
      slot: 'course',
      webSearch: false,
    });

    expect(result).toEqual({ title: 'Corso' });
    expect(runAiObject).not.toHaveBeenCalled();
    expect(runCodexObject).toHaveBeenCalledWith(
      expect.objectContaining({
        allowWebSearch: false,
        model: config.codexCourseModel,
        signal,
      })
    );
  });

  test('adapts optional Zod fields to the strict Codex schema without changing domain output', async () => {
    const optionalSchema = z
      .object({
        metadata: z.object({ detail: z.string().optional() }).strict(),
        mode: z.string().nullable(),
        nullableNote: z.string().nullable().optional(),
        rows: z.array(z.object({ url: z.string().optional() }).strict()),
        title: z.string(),
        note: z.string().optional(),
      })
      .strict();
    const runCodexObject = vi
      .fn()
      .mockResolvedValue(
        '{"metadata":{"detail":null},"mode":null,"nullableNote":null,"rows":[{"url":null}],"title":"Corso","note":null}'
      );
    const generate = createCourseObjectGenerator({ runAiObject: vi.fn(), runCodexObject });
    const config = {
      ...getGlobalModelConfig(),
      aiProvider: 'codex' as const,
      aiProviderOverrides: { course: 'codex' as const },
    };

    await expect(
      generate({
        config,
        developerInstructions: 'Restituisci il corso.',
        name: 'course_plan',
        prompt: 'Crea il corso.',
        schema: optionalSchema,
        signal: new AbortController().signal,
        slot: 'course',
      })
    ).resolves.toEqual({
      metadata: {},
      mode: null,
      nullableNote: null,
      rows: [{}],
      title: 'Corso',
    });

    const outputSchema = runCodexObject.mock.calls[0]?.[0].outputSchema as {
      properties: Record<string, { anyOf?: unknown[]; properties?: Record<string, unknown> }>;
      required: string[];
    };
    expect(outputSchema.required).toEqual([
      'metadata',
      'mode',
      'nullableNote',
      'rows',
      'title',
      'note',
    ]);
    expect(outputSchema.properties.note.anyOf).toContainEqual({ type: 'null' });
    expect(outputSchema.properties.metadata.properties).toMatchObject({
      detail: { anyOf: expect.arrayContaining([{ type: 'null' }]) },
    });
  });

  test('adapts a root discriminated union to the Codex structured-output contract', async () => {
    const unionSchema = z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('question'), message: z.string() }).strict(),
      z.object({ kind: z.literal('proposal'), title: z.string() }).strict(),
    ]);
    const runCodexObject = vi
      .fn()
      .mockResolvedValue('{"result":{"kind":"question","message":"Qual è il tuo livello?"}}');
    const generate = createCourseObjectGenerator({ runAiObject: vi.fn(), runCodexObject });
    const config = {
      ...getGlobalModelConfig(),
      aiProvider: 'codex' as const,
      aiProviderOverrides: { assessment: 'codex' as const },
    };

    await expect(
      generate({
        config,
        developerInstructions: 'Fai una domanda. ',
        name: 'assessment_turn',
        prompt: 'Continua.',
        schema: unionSchema,
        signal: new AbortController().signal,
        slot: 'assessment',
      })
    ).resolves.toEqual({ kind: 'question', message: 'Qual è il tuo livello?' });

    expect(runCodexObject).toHaveBeenCalledWith(
      expect.objectContaining({
        outputSchema: {
          additionalProperties: false,
          properties: { result: expect.objectContaining({ anyOf: expect.any(Array) }) },
          required: ['result'],
          type: 'object',
        },
      })
    );
  });

  test('removes the unsupported URI format while preserving URL domain validation', async () => {
    const urlSchema = z.object({ sources: z.array(z.url()) }).strict();
    const runCodexObject = vi.fn().mockResolvedValue('{"sources":["https://example.com/"]}');
    const generate = createCourseObjectGenerator({ runAiObject: vi.fn(), runCodexObject });
    const config = {
      ...getGlobalModelConfig(),
      aiProvider: 'codex' as const,
      aiProviderOverrides: { course: 'codex' as const },
    };

    await expect(
      generate({
        config,
        developerInstructions: 'Restituisci le fonti. ',
        name: 'course_sources',
        prompt: 'Elenca le fonti.',
        schema: urlSchema,
        signal: new AbortController().signal,
        slot: 'course',
      })
    ).resolves.toEqual({ sources: ['https://example.com/'] });

    const outputSchema = runCodexObject.mock.calls[0]?.[0].outputSchema as {
      properties: { sources: { items: Record<string, unknown> } };
    };
    expect(outputSchema.properties.sources.items).not.toHaveProperty('format');
  });

  test('routes hosted providers through the AI SDK and makes invalid structure corrective', async () => {
    const runAiObject = vi.fn().mockRejectedValue(
      new NoObjectGeneratedError({
        finishReason: 'stop',
        response: { id: 'response', modelId: 'model', timestamp: new Date() },
        text: '{"title":""}',
        usage: {
          inputTokenDetails: {
            cacheReadTokens: undefined,
            cacheWriteTokens: undefined,
            noCacheTokens: undefined,
          },
          inputTokens: undefined,
          outputTokenDetails: { reasoningTokens: undefined, textTokens: undefined },
          outputTokens: undefined,
          totalTokens: undefined,
        },
      })
    );
    const runCodexObject = vi.fn();
    const generate = createCourseObjectGenerator({ runAiObject, runCodexObject });
    const config = {
      ...getGlobalModelConfig(),
      aiProvider: 'openrouter' as const,
      aiProviderOverrides: { research: 'openrouter' as const },
    };

    await expect(
      generate({
        config,
        developerInstructions: 'Ricerca.',
        name: 'course_research',
        prompt: 'Ricerca.',
        schema,
        signal: new AbortController().signal,
        slot: 'research',
        webSearch: true,
      })
    ).rejects.toThrowError(
      expect.objectContaining({
        failure: expect.objectContaining({
          code: 'course_model_output_invalid',
          kind: 'corrective',
        }),
      })
    );
    expect(runCodexObject).not.toHaveBeenCalled();
    expect(runAiObject).toHaveBeenCalledWith(
      expect.objectContaining({ slot: 'research', webSearch: true })
    );
  });

  test('makes malformed Codex JSON corrective instead of treating it as a provider outage', async () => {
    const generate = createCourseObjectGenerator({
      runAiObject: vi.fn(),
      runCodexObject: vi.fn().mockResolvedValue('{not-json'),
    });
    const config = {
      ...getGlobalModelConfig(),
      aiProvider: 'codex' as const,
      aiProviderOverrides: { course: 'codex' as const },
    };

    await expect(
      generate({
        config,
        developerInstructions: 'Restituisci il corso.',
        name: 'course_plan',
        prompt: 'Crea il corso.',
        schema,
        signal: new AbortController().signal,
        slot: 'course',
      })
    ).rejects.toThrowError(
      expect.objectContaining({
        failure: expect.objectContaining({
          code: 'course_model_output_invalid',
          feedback: expect.stringContaining('JSON'),
          kind: 'corrective',
        }),
      })
    );
  });

  test('adapts validated server tools for Codex without exposing host capabilities', async () => {
    const execute = vi.fn(async ({ path }: { path: string }) => ({ path }));
    const runCodexObject = vi.fn(async input => {
      const archiveTool = input.tools?.find(tool => tool.name === 'read_source_file');
      await archiveTool?.execute?.({ path: 'src/index.ts' }, 'tool-call-1');
      return '{"title":"Corso da archivio"}';
    });
    const generate = createCourseObjectGenerator({ runAiObject: vi.fn(), runCodexObject });
    const config = {
      ...getGlobalModelConfig(),
      aiProvider: 'codex' as const,
      aiProviderOverrides: { course: 'codex' as const },
    };

    await generate({
      config,
      developerInstructions: 'Consulta soltanto gli strumenti forniti.',
      name: 'archive_course_plan',
      prompt: 'Crea il corso.',
      schema,
      signal: new AbortController().signal,
      slot: 'course',
      tools: {
        read_source_file: {
          description: 'Legge un file testuale della sorgente.',
          execute,
          inputSchema: z.object({ path: z.string().min(1) }).strict(),
        },
      },
    });

    expect(execute).toHaveBeenCalledWith({ path: 'src/index.ts' });
    expect(runCodexObject).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: [
          expect.objectContaining({
            description: 'Legge un file testuale della sorgente.',
            name: 'read_source_file',
          }),
        ],
      })
    );
  });
});
