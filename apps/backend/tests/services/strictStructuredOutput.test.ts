import { afterEach, expect, test, vi } from 'vitest';
import * as z from 'zod';

import { getGlobalModelConfig } from '../../src/config/modelConfig.js';
import { generateStructuredOutput } from '../../src/services/structuredGeneration.js';
import { isRecord } from '../../src/utils/validation.js';
import { generateCourseObject } from '../../src/workflows/courseGenerationModel.js';
import { CourseWebResearchSchema } from '../../src/workflows/courseGenerationWorkflowContract.js';

const expectStrictObjects = (schema: unknown): void => {
  if (Array.isArray(schema)) {
    schema.forEach(expectStrictObjects);
    return;
  }
  if (!isRecord(schema)) return;
  if (isRecord(schema.properties)) {
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toStrictEqual(Object.keys(schema.properties));
  }
  Object.values(schema).forEach(expectStrictObjects);
};

const modelOutput = {
  brief: 'Distributed systems communicate over networks.',
  sources: [
    {
      title: 'Reference',
      note: null,
      url: 'https://example.org/reference',
      videoClip: null,
      youtubeTranscript: null,
    },
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

test.each([
  'course',
  'structured',
] as const)('OpenRouter %s transport sends a strict-valid research schema and restores optional absence', async path => {
  vi.stubEnv('OPENROUTER_API_KEY', 'synthetic-test-key');
  const fetchRequest = vi.fn(async (_url: unknown, options: RequestInit | undefined) => {
    const body = JSON.parse(String(options?.body));
    expect(body.model).toBe('openai/gpt-5.6-luna');
    expect(body.response_format.type).toBe('json_schema');
    expect(body.response_format.json_schema.strict).toBe(true);
    const schema = body.response_format.json_schema.schema;
    expectStrictObjects(schema);
    expect(z.fromJSONSchema(schema).safeParse(modelOutput).success).toBe(true);
    return Response.json({
      id: 'synthetic-response',
      model: body.model,
      created: 0,
      choices: [
        {
          index: 0,
          finish_reason: 'stop',
          message: { role: 'assistant', content: JSON.stringify(modelOutput) },
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
  });
  vi.stubGlobal('fetch', fetchRequest);
  const config = {
    ...getGlobalModelConfig(),
    aiProvider: 'openrouter' as const,
    aiProviderOverrides: { research: 'openrouter' as const },
    researchModel: 'openai/gpt-5.6-luna',
    researchReasoningEffort: 'none' as const,
  };
  const common = {
    config,
    prompt: 'Research distributed systems.',
    signal: new AbortController().signal,
    slot: 'research' as const,
    webSearch: true,
  };
  const originalSchema = z.toJSONSchema(CourseWebResearchSchema);
  const response =
    path === 'course'
      ? await generateCourseObject({
          ...common,
          developerInstructions: 'Return researched facts.',
          name: 'course_web_research',
          schema: CourseWebResearchSchema,
        })
      : await generateStructuredOutput({
          ...common,
          system: 'Return researched facts.',
          output: { name: 'course_web_research', schema: originalSchema },
        });
  expect(response).toStrictEqual({
    brief: modelOutput.brief,
    sources: [{ title: 'Reference', url: 'https://example.org/reference' }],
  });
  expect(CourseWebResearchSchema.safeParse(response).success).toBe(true);
  expect(z.toJSONSchema(CourseWebResearchSchema)).toStrictEqual(originalSchema);
  expect(fetchRequest).toHaveBeenCalledTimes(1);
});
