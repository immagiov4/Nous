import { TRANSCRIBED_SOURCE_RULE } from '@shared/pdfTranscription';
import { beforeEach, expect, test, vi } from 'vitest';
import * as z from 'zod';
import { getGlobalModelConfig } from '../../src/config/modelConfig.js';
import { generateStructuredOutput } from '../../src/services/structuredGeneration.js';
import { isRecord } from '../../src/utils/validation.js';

const { createConfiguredTextModelFromResolution, generateText, runCodexAppServerTurn } = vi.hoisted(
  () => ({
    createConfiguredTextModelFromResolution: vi.fn(),
    generateText: vi.fn(),
    runCodexAppServerTurn: vi.fn(),
  })
);

vi.mock('../../src/services/codexAppServer.js', () => ({ runCodexAppServerTurn }));
vi.mock('../../src/services/aiSdkTextModel.js', () => ({
  createConfiguredTextModelFromResolution,
}));
vi.mock('ai', async importOriginal => ({
  ...(await importOriginal<typeof import('ai')>()),
  generateText,
}));

const OUTPUT = {
  name: 'answer',
  schema: {
    additionalProperties: false,
    properties: { answer: { type: 'string' } },
    required: ['answer'],
    type: 'object',
  },
};

const signal = new AbortController().signal;

const request = (provider: 'codex' | 'openrouter') => ({
  config: { ...getGlobalModelConfig(), aiProviderOverrides: { lesson: provider } },
  output: OUTPUT,
  prompt: 'Domanda',
  reasoningEffort: 'medium' as const,
  signal,
  slot: 'lesson' as const,
  system: 'Rispondi.',
});

beforeEach(() => {
  createConfiguredTextModelFromResolution.mockReset();
  generateText.mockReset();
  runCodexAppServerTurn.mockReset();
});

test('Codex turns are tool-free, schema-bound, and parsed as JSON', async () => {
  runCodexAppServerTurn.mockResolvedValue('{"answer":"42"}');

  await expect(generateStructuredOutput(request('codex'))).resolves.toEqual({ answer: '42' });

  expect(generateText).not.toHaveBeenCalled();
  expect(runCodexAppServerTurn).toHaveBeenCalledWith(
    expect.objectContaining({
      allowWebSearch: false,
      developerInstructions: 'Rispondi. Do not use tools or access local files.',
      input: [{ text: 'Domanda', type: 'text' }],
      outputSchema: OUTPUT.schema,
      reasoningEffort: 'medium',
      signal,
    })
  );
});

test('web search lets Codex search while still forbidding local files', async () => {
  runCodexAppServerTurn.mockResolvedValue('{"answer":"42"}');

  await generateStructuredOutput({ ...request('codex'), webSearch: true });

  expect(runCodexAppServerTurn).toHaveBeenCalledWith(
    expect.objectContaining({
      allowWebSearch: true,
      developerInstructions: 'Rispondi. Do not access local files.',
    })
  );
});

test('web search passes the provider search tools to AI SDK models', async () => {
  const tools = { web_search: {} };
  createConfiguredTextModelFromResolution.mockReturnValue({
    model: 'model',
    providerOptions: {},
    tools,
  });
  generateText.mockResolvedValue({ output: { answer: '42' } });

  await generateStructuredOutput({ ...request('openrouter'), webSearch: true });

  expect(createConfiguredTextModelFromResolution).toHaveBeenCalledWith(
    expect.objectContaining({ provider: 'openrouter', reasoningEffort: 'medium' }),
    { webSearch: true }
  );
  expect(generateText.mock.lastCall?.[0].tools).toBe(tools);
});

test('malformed Codex output surfaces as a SyntaxError', async () => {
  runCodexAppServerTurn.mockResolvedValue('not json');

  await expect(generateStructuredOutput(request('codex'))).rejects.toBeInstanceOf(SyntaxError);
});

test('AI SDK providers receive the system prompt unchanged', async () => {
  createConfiguredTextModelFromResolution.mockReturnValue({
    model: 'model',
    providerOptions: { p: {} },
  });
  generateText.mockResolvedValue({ output: { answer: '42' } });

  await expect(generateStructuredOutput(request('openrouter'))).resolves.toEqual({
    answer: '42',
  });

  expect(runCodexAppServerTurn).not.toHaveBeenCalled();
  expect(createConfiguredTextModelFromResolution).toHaveBeenCalledWith(
    expect.objectContaining({ provider: 'openrouter', reasoningEffort: 'medium' }),
    { webSearch: false }
  );
  const call = generateText.mock.lastCall?.[0];
  expect(call).toMatchObject({
    abortSignal: signal,
    maxRetries: 0,
    prompt: 'Domanda',
    providerOptions: { p: {} },
    system: 'Rispondi.',
  });
  await expect(call.output.responseFormat).resolves.toMatchObject({
    name: 'answer',
    schema: OUTPUT.schema,
    type: 'json',
  });
});

test('falls back to a JSON string envelope when a provider rejects schema compilation', async () => {
  createConfiguredTextModelFromResolution.mockReturnValue({
    model: 'model',
    providerOptions: {},
  });
  generateText
    .mockRejectedValueOnce(
      new Error(
        "[Azure] Invalid schema for response_format 'answer': 'additionalProperties' is required to be supplied and to be false."
      )
    )
    .mockResolvedValueOnce({ output: { payload: '{"answer":"42"}' } });

  await expect(generateStructuredOutput(request('openrouter'))).resolves.toEqual({
    answer: '42',
  });
  expect(generateText).toHaveBeenCalledTimes(2);
  const fallback = generateText.mock.calls[1][0];
  expect(fallback.prompt).toContain('JSON-encoded string');
  await expect(fallback.output.responseFormat).resolves.toMatchObject({
    schema: {
      additionalProperties: false,
      properties: { payload: { type: 'string' } },
      required: ['payload'],
      type: 'object',
    },
  });
});

test.each([
  '[Google] Schemas contains too many optional parameters (33), which would make grammar compilation inefficient. Reduce the number of optional parameters in your tool schemas (limit: 24).',
  '[Google] Schemas contains too many parameters with union types (37 parameters with type arrays or anyOf). This causes exponential compilation cost. Reduce the number of nullable or union-typed parameters (limit: 16 parameters with unions).',
])('schema compilation limits use the existing JSON envelope: %s', async message => {
  createConfiguredTextModelFromResolution.mockReturnValue({ model: 'model', providerOptions: {} });
  generateText
    .mockRejectedValueOnce(new Error(message))
    .mockResolvedValueOnce({ output: { payload: '{"answer":"42"}' } });
  await expect(generateStructuredOutput(request('openrouter'))).resolves.toEqual({ answer: '42' });
  expect(generateText).toHaveBeenCalledTimes(2);
});

test('schema rejection preserves the original contract for the envelope model to consume', async () => {
  const contract = z.strictObject({
    type: z.enum(['checklist', 'steps']),
    iconQueries: z.strictObject({ subject: z.array(z.string()), action: z.array(z.string()) }),
  });
  const output = { name: 'synthetic_scene', schema: z.toJSONSchema(contract) };
  const original = { ...request('openrouter'), output, prompt: 'Explain a synthetic process.' };
  createConfiguredTextModelFromResolution.mockReturnValue({ model: 'model', providerOptions: {} });
  generateText
    .mockRejectedValueOnce(
      new Error("Invalid schema for response_format 'synthetic_scene': required is missing 'id'.")
    )
    .mockImplementationOnce(async fallback => {
      const schema = JSON.parse(fallback.prompt.slice(fallback.prompt.lastIndexOf('\n\n') + 2));
      expect(schema).toEqual(output.schema);
      return {
        output: {
          payload: JSON.stringify({
            type: schema.properties.type.enum[0],
            iconQueries: Object.fromEntries(
              Object.keys(schema.properties.iconQueries.properties).map(key => [
                key,
                ['synthetic query'],
              ])
            ),
          }),
        },
      };
    });

  const result = await generateStructuredOutput<unknown>(original);

  expect(contract.parse(result)).toEqual({
    type: 'checklist',
    iconQueries: { subject: ['synthetic query'], action: ['synthetic query'] },
  });
  expect(generateText).toHaveBeenCalledTimes(2);
  const fallback = generateText.mock.calls[1][0];
  expect(fallback.prompt.startsWith(`${original.prompt}\n\n`)).toBe(true);
  expect(fallback.system).toBe(original.system);
  await expect(fallback.output.responseFormat).resolves.toMatchObject({
    schema: {
      additionalProperties: false,
      properties: { payload: { type: 'string' } },
      required: ['payload'],
      type: 'object',
    },
  });
});

test('a resolved model bypasses slot configuration and keeps its service tier', async () => {
  runCodexAppServerTurn.mockResolvedValue('{"answer":"42"}');

  await generateStructuredOutput({
    model: {
      model: 'pinned-model',
      provider: 'codex',
      reasoningEffort: 'low',
      serviceTier: 'fast',
    },
    output: OUTPUT,
    prompt: 'Domanda',
    signal,
    system: `Rispondi.\n${TRANSCRIBED_SOURCE_RULE}`,
  });

  expect(runCodexAppServerTurn).toHaveBeenCalledWith(
    expect.objectContaining({ model: 'pinned-model', reasoningEffort: 'low', serviceTier: 'fast' })
  );
});

test('an image precedes the prompt for both providers', async () => {
  runCodexAppServerTurn.mockResolvedValue('{"answer":"42"}');
  await generateStructuredOutput({ ...request('codex'), image: 'data:image/png;base64,AA' });
  expect(runCodexAppServerTurn.mock.lastCall?.[0].input).toEqual([
    { type: 'image', url: 'data:image/png;base64,AA' },
    { text: 'Domanda', type: 'text' },
  ]);

  createConfiguredTextModelFromResolution.mockReturnValue({ model: 'model', providerOptions: {} });
  generateText.mockResolvedValue({ output: { answer: '42' } });
  await generateStructuredOutput({ ...request('openrouter'), image: 'data:image/png;base64,AA' });
  const call = generateText.mock.lastCall?.[0];
  expect(call.prompt).toBeUndefined();
  expect(call.messages).toEqual([
    {
      content: [
        { image: 'data:image/png;base64,AA', type: 'image' },
        { text: 'Domanda', type: 'text' },
      ],
      role: 'user',
    },
  ]);
});

test('AI SDK transport retries are off unless the caller asks for them', async () => {
  createConfiguredTextModelFromResolution.mockReturnValue({ model: 'model', providerOptions: {} });
  generateText.mockResolvedValue({ output: { answer: '42' } });

  await generateStructuredOutput(request('openrouter'));
  expect(generateText.mock.lastCall?.[0].maxRetries).toBe(0);

  await generateStructuredOutput({ ...request('openrouter'), maxRetries: 2 });
  expect(generateText.mock.lastCall?.[0].maxRetries).toBe(2);
});

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
  expect(schema).not.toHaveProperty('oneOf');
  Object.values(schema).forEach(expectStrictObjects);
};

const nestedOptionalSchema = z.strictObject({
  metadata: z.strictObject({ detail: z.string().optional() }),
  rows: z.array(z.strictObject({ note: z.string().optional() })).nullable(),
  choice: z
    .discriminatedUnion('kind', [
      z.strictObject({ kind: z.enum(['first', 'alternate']), note: z.string().optional() }),
      z.strictObject({ kind: z.literal('second'), count: z.number().optional() }),
    ])
    .nullable(),
  title: z.string(),
  nullable: z.string().nullable().optional(),
});
const { $schema: _nestedDialect, ...nestedOutputSchema } = z.toJSONSchema(nestedOptionalSchema);
const nestedModelOutput = {
  metadata: { detail: null },
  rows: [{ note: null }, { note: 'retained' }],
  choice: { kind: 'second', count: null },
  title: 'Lesson',
  nullable: null,
};
const optionalRequest = () => ({
  ...request('codex'),
  output: { name: 'nested_optional', schema: nestedOutputSchema },
});

test('Codex receives a strict-valid schema for nested optional properties and object arrays', async () => {
  const originalSchema = structuredClone(nestedOutputSchema);
  runCodexAppServerTurn.mockImplementation(async input => {
    expectStrictObjects(input.outputSchema);
    expect(z.fromJSONSchema(input.outputSchema).safeParse(nestedModelOutput).success).toBe(true);
    return JSON.stringify(nestedModelOutput);
  });
  await generateStructuredOutput(optionalRequest());
  expect(nestedOutputSchema).toStrictEqual(originalSchema);
});

test.each([
  'slot',
  'resolved',
] as const)('Codex %s targets restore optional absence before caller validation and preserve explicit nulls', async target => {
  runCodexAppServerTurn.mockResolvedValue(JSON.stringify(nestedModelOutput));
  const input = optionalRequest();
  const result = await generateStructuredOutput(
    target === 'slot'
      ? input
      : {
          model: { provider: 'codex', model: 'test-model', reasoningEffort: 'medium' },
          output: input.output,
          prompt: input.prompt,
          system: input.system,
          signal,
        }
  );
  expect(result).toStrictEqual({
    metadata: {},
    rows: [{}, { note: 'retained' }],
    choice: { kind: 'second' },
    title: 'Lesson',
    nullable: null,
  });
  expect(nestedOptionalSchema.safeParse(result).success).toBe(true);
  runCodexAppServerTurn.mockResolvedValue(
    JSON.stringify({ ...nestedModelOutput, title: null, extra: 'invalid' })
  );
  const invalid = await generateStructuredOutput(optionalRequest());
  expect(invalid).toMatchObject({ title: null, extra: 'invalid' });
  expect(nestedOptionalSchema.safeParse(invalid).success).toBe(false);
});

test.each([
  'anyOf',
  'oneOf',
] as const)('Codex wraps root %s unions and normalizes the selected branch including nullable type arrays', async unionKeyword => {
  const schema = {
    [unionKeyword]: [
      {
        type: 'object',
        additionalProperties: false,
        properties: { kind: { const: 'first', type: 'string' }, note: { type: 'string' } },
        required: ['kind'],
      },
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { const: 'second', type: 'string' },
          count: { type: 'number' },
          nullable: { type: ['string', 'null'] },
        },
        required: ['kind'],
      },
    ],
  };
  runCodexAppServerTurn.mockImplementation(async input => {
    expectStrictObjects(input.outputSchema);
    expect(input.outputSchema.type).toBe('object');
    return '{"result":{"kind":"second","count":null,"nullable":null}}';
  });
  await expect(
    generateStructuredOutput({ ...request('codex'), output: { name: 'union', schema } })
  ).resolves.toStrictEqual({ kind: 'second', nullable: null });
});

test('Codex restores optional fields in untagged object unions before domain validation', async () => {
  const unionSchema = z.strictObject({
    rows: z.array(
      z.union([
        z.strictObject({ name: z.string(), note: z.string().optional() }),
        z.strictObject({ count: z.number(), detail: z.string().optional() }),
      ])
    ),
  });
  const { $schema: _dialect, ...schema } = z.toJSONSchema(unionSchema);
  const modelOutput = '{"rows":[{"count":2,"detail":null},{"name":"kept","note":null}]}';
  runCodexAppServerTurn.mockImplementation(async input => {
    expectStrictObjects(input.outputSchema);
    expect(z.fromJSONSchema(input.outputSchema).safeParse(JSON.parse(modelOutput)).success).toBe(
      true
    );
    return modelOutput;
  });
  const result = await generateStructuredOutput({
    ...request('codex'),
    output: { name: 'untagged', schema },
  });
  expect(result).toStrictEqual({ rows: [{ count: 2 }, { name: 'kept' }] });
  expect(unionSchema.safeParse(result).success).toBe(true);
});

test.each([
  z.array(z.strictObject({ note: z.string().optional(), nullable: z.string().nullable() })),
  z.union([
    z.strictObject({
      kind: z.literal('first'),
      note: z.string().optional(),
      nullable: z.string().nullable(),
    }),
    z.strictObject({ kind: z.literal('second') }),
  ]),
])('envelope payload normalization preserves the original root and explicit nullability', async contract => {
  const value = { note: null, nullable: null };
  const payload = contract instanceof z.ZodArray ? [value] : { kind: 'first', ...value };
  createConfiguredTextModelFromResolution.mockReturnValue({ model: 'model', providerOptions: {} });
  generateText
    .mockRejectedValueOnce(new Error('Schema is too complex'))
    .mockResolvedValueOnce({ output: { payload: JSON.stringify(payload) } });
  const result = await generateStructuredOutput({
    ...request('openrouter'),
    output: { name: 'root_contract', schema: z.toJSONSchema(contract) },
  });
  expect(contract.parse(result)).toEqual(
    Array.isArray(payload) ? [{ nullable: null }] : { kind: 'first', nullable: null }
  );
});

test('enables source interpretation only when explicitly requested', async () => {
  createConfiguredTextModelFromResolution.mockReturnValue({ model: 'model', providerOptions: {} });
  generateText.mockResolvedValue({ output: { answer: '42' } });
  await generateStructuredOutput({ ...request('openrouter'), sourceAware: true });
  expect(generateText.mock.lastCall?.[0].system).toBe(`Rispondi.\n${TRANSCRIBED_SOURCE_RULE}`);
});
