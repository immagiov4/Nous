import { generateText, jsonSchema, NoObjectGeneratedError, Output, stepCountIs, tool } from 'ai';
import * as z from 'zod';

import {
  type GlobalModelConfig,
  resolveAiProviderForSlot,
  resolveCodexServiceTierForSlot,
  resolveTextModelConfig,
  type TextModelSlot,
} from '../config/modelConfig.js';
import { createConfiguredTextModel } from '../services/aiSdkTextModel.js';
import {
  type CodexTurnInput,
  type CodexTurnTool,
  runCodexAppServerTurn,
} from '../services/codexAppServer.js';
import { isRecord } from '../utils/validation.js';
import { retryCorrective } from './retryPolicy.js';
import type { DeepReadonly } from './types.js';

export interface CourseObjectTool {
  readonly description: string;
  readonly execute: (input: unknown) => Promise<unknown>;
  readonly inputSchema: z.ZodType;
}

export type CourseObjectToolSet = Readonly<Record<string, CourseObjectTool>>;

export class CourseModelProviderError extends Error {
  constructor(cause: unknown) {
    super('The course model request failed.', { cause });
    this.name = 'CourseModelProviderError';
  }
}

interface ResolvedCourseObjectRequest {
  readonly config: GlobalModelConfig;
  readonly developerInstructions: string;
  readonly name: string;
  readonly outputSchema: Record<string, unknown>;
  readonly prompt: string;
  readonly signal: AbortSignal;
  readonly slot: TextModelSlot;
  readonly maxToolSteps?: number;
  readonly tools?: CourseObjectToolSet;
  readonly webSearch: boolean;
}

interface CourseObjectGeneratorDependencies {
  readonly runAiObject: (input: ResolvedCourseObjectRequest) => Promise<unknown>;
  readonly runCodexObject: (input: CodexTurnInput) => Promise<string>;
}

export interface GenerateCourseObjectInput<Schema extends z.ZodType> {
  readonly config: DeepReadonly<GlobalModelConfig>;
  readonly developerInstructions: string;
  readonly name: string;
  readonly prompt: string;
  readonly schema: Schema;
  readonly signal: AbortSignal;
  readonly slot: TextModelSlot;
  readonly maxToolSteps?: number;
  readonly tools?: CourseObjectToolSet;
  readonly webSearch?: boolean;
}

const toProviderSchema = (schema: z.ZodType): Record<string, unknown> => {
  const { $schema: _schemaDialect, ...providerSchema } = z.toJSONSchema(schema) as Record<
    string,
    unknown
  >;
  return providerSchema;
};

const acceptsNull = (schema: Record<string, unknown>): boolean =>
  schema.type === 'null' ||
  (Array.isArray(schema.anyOf) &&
    schema.anyOf.some(candidate => isRecord(candidate) && candidate.type === 'null'));

const toCodexOutputSchema = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(toCodexOutputSchema);
  if (!isRecord(value)) return value;

  let converted = Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, toCodexOutputSchema(child)])
  );
  if (Array.isArray(converted.oneOf)) {
    const { oneOf, ...supportedSchema } = converted;
    converted = { ...supportedSchema, anyOf: oneOf };
  }
  if (converted.format === 'uri') {
    const { format: _unsupportedFormat, ...supportedSchema } = converted;
    converted = supportedSchema;
  }
  if (!isRecord(value.properties)) return converted;

  const originallyRequired = new Set(
    Array.isArray(value.required)
      ? value.required.filter((key): key is string => typeof key === 'string')
      : []
  );
  const properties = Object.fromEntries(
    Object.entries(value.properties).map(([key, property]) => {
      const convertedProperty = toCodexOutputSchema(property);
      if (
        originallyRequired.has(key) ||
        !isRecord(convertedProperty) ||
        acceptsNull(convertedProperty)
      ) {
        return [key, convertedProperty];
      }
      return [key, { anyOf: [convertedProperty, { type: 'null' }] }];
    })
  );
  return { ...converted, properties, required: Object.keys(properties) };
};

const schemaMatchesValue = (schema: Record<string, unknown>, value: unknown): boolean => {
  if ('const' in schema) return Object.is(schema.const, value);
  if (schema.type === 'object') {
    if (!isRecord(value)) return false;
    if (!isRecord(schema.properties)) return true;
    return Object.entries(schema.properties).every(
      ([key, property]) =>
        !isRecord(property) || !('const' in property) || property.const === value[key]
    );
  }
  if (schema.type === 'array') return Array.isArray(value);
  if (schema.type === 'string') return typeof value === 'string';
  if (schema.type === 'number' || schema.type === 'integer') return typeof value === 'number';
  if (schema.type === 'boolean') return typeof value === 'boolean';
  if (schema.type === 'null') return value === null;
  return true;
};

const selectSchemaBranch = (
  schema: Record<string, unknown>,
  value: unknown
): Record<string, unknown> => {
  let branches: unknown[] | undefined;
  if (Array.isArray(schema.anyOf)) branches = schema.anyOf;
  else if (Array.isArray(schema.oneOf)) branches = schema.oneOf;
  if (!branches) return schema;
  return (branches.find(branch => isRecord(branch) && schemaMatchesValue(branch, value)) ??
    schema) as Record<string, unknown>;
};

const omitOptionalNulls = (value: unknown, schema: unknown): unknown => {
  if (!isRecord(schema)) return value;
  const selectedSchema = selectSchemaBranch(schema, value);
  if (Array.isArray(value)) {
    return value.map(entry => omitOptionalNulls(entry, selectedSchema.items));
  }
  if (!isRecord(value) || !isRecord(selectedSchema.properties)) return value;

  const properties = selectedSchema.properties;
  const required = new Set(
    Array.isArray(selectedSchema.required)
      ? selectedSchema.required.filter((key): key is string => typeof key === 'string')
      : []
  );
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, child]) => {
      const propertySchema = properties[key];
      if (
        child === null &&
        !required.has(key) &&
        isRecord(propertySchema) &&
        !acceptsNull(propertySchema)
      ) {
        return [];
      }
      return [[key, omitOptionalNulls(child, propertySchema)]];
    })
  );
};

const toAiSdkTools = (tools: CourseObjectToolSet | undefined) =>
  tools
    ? Object.fromEntries(
        Object.entries(tools).map(([name, definition]) => [
          name,
          tool({
            description: definition.description,
            execute: input => definition.execute(definition.inputSchema.parse(input)),
            inputSchema: definition.inputSchema,
          }),
        ])
      )
    : undefined;

const runAiObject = async (input: ResolvedCourseObjectRequest): Promise<unknown> => {
  const configured = createConfiguredTextModel(input.config, input.slot, {
    webSearch: input.webSearch,
  });
  const tools = toAiSdkTools(input.tools);
  const { output } = await generateText({
    abortSignal: input.signal,
    maxRetries: 0,
    model: configured.model,
    output: Output.object({
      name: input.name,
      schema: jsonSchema(input.outputSchema as Parameters<typeof jsonSchema>[0]),
    }),
    prompt: input.prompt,
    providerOptions: configured.providerOptions,
    system: input.developerInstructions,
    ...(tools || configured.tools ? { tools: { ...configured.tools, ...tools } } : {}),
    ...(tools && input.maxToolSteps ? { stopWhen: stepCountIs(input.maxToolSteps) } : {}),
  });
  return output;
};

const toCodexTools = (
  tools: CourseObjectToolSet | undefined,
  maxToolSteps: number | undefined
): CodexTurnTool[] | undefined => {
  if (!tools) return undefined;
  let toolCallCount = 0;
  return Object.entries(tools).map(([name, definition]) => ({
    description: definition.description,
    execute: async input => {
      toolCallCount += 1;
      if (maxToolSteps !== undefined && toolCallCount > maxToolSteps) {
        throw new Error('Course model exceeded its source-tool consultation limit.');
      }
      return definition.execute(definition.inputSchema.parse(input));
    },
    inputSchema: toProviderSchema(definition.inputSchema),
    name,
  }));
};

const productionDependencies: CourseObjectGeneratorDependencies = {
  runAiObject,
  runCodexObject: runCodexAppServerTurn,
};

const requestCourseObject = async <Schema extends z.ZodType>({
  config,
  dependencies,
  input,
  outputSchema,
  webSearch,
}: {
  config: GlobalModelConfig;
  dependencies: CourseObjectGeneratorDependencies;
  input: GenerateCourseObjectInput<Schema>;
  outputSchema: Record<string, unknown>;
  webSearch: boolean;
}): Promise<unknown> => {
  if (resolveAiProviderForSlot(config, input.slot) !== 'codex') {
    return dependencies.runAiObject({
      config,
      developerInstructions: input.developerInstructions,
      name: input.name,
      outputSchema,
      prompt: input.prompt,
      signal: input.signal,
      slot: input.slot,
      ...(input.maxToolSteps === undefined ? {} : { maxToolSteps: input.maxToolSteps }),
      ...(input.tools ? { tools: input.tools } : {}),
      webSearch,
    });
  }

  const model = resolveTextModelConfig(config, input.slot);
  const strictSchema = toCodexOutputSchema(outputSchema) as Record<string, unknown>;
  const wrapsRootValue = strictSchema.type !== 'object';
  const response = await dependencies.runCodexObject({
    allowWebSearch: webSearch,
    developerInstructions: input.developerInstructions,
    input: [{ text: input.prompt, type: 'text' }],
    model: model.model,
    outputSchema: wrapsRootValue
      ? {
          additionalProperties: false,
          properties: { result: strictSchema },
          required: ['result'],
          type: 'object',
        }
      : strictSchema,
    reasoningEffort: model.reasoningEffort,
    serviceTier: resolveCodexServiceTierForSlot(config, input.slot),
    signal: input.signal,
    ...(input.tools
      ? { tools: toCodexTools(input.tools, input.maxToolSteps) as CodexTurnTool[] }
      : {}),
  });
  const parsedResponse = JSON.parse(response);
  const rawOutput =
    wrapsRootValue && isRecord(parsedResponse) ? parsedResponse.result : parsedResponse;
  return omitOptionalNulls(rawOutput, outputSchema);
};

export const createCourseObjectGenerator =
  (dependencies: CourseObjectGeneratorDependencies = productionDependencies) =>
  async <Schema extends z.ZodType>(
    input: GenerateCourseObjectInput<Schema>
  ): Promise<z.output<Schema>> => {
    const config = input.config as GlobalModelConfig;
    const outputSchema = toProviderSchema(input.schema);
    const webSearch = input.webSearch ?? false;
    if (
      input.maxToolSteps !== undefined &&
      (!Number.isSafeInteger(input.maxToolSteps) || input.maxToolSteps < 1)
    ) {
      throw new RangeError('maxToolSteps must be a positive safe integer.');
    }
    try {
      const output = await requestCourseObject({
        config,
        dependencies,
        input,
        outputSchema,
        webSearch,
      });
      return input.schema.parse(output);
    } catch (error) {
      input.signal.throwIfAborted();
      if (
        !(error instanceof SyntaxError) &&
        !(error instanceof z.ZodError) &&
        !NoObjectGeneratedError.isInstance(error)
      ) {
        throw new CourseModelProviderError(error);
      }
      throw retryCorrective({
        code: 'course_model_output_invalid',
        feedback:
          'Return valid JSON that exactly matches the requested schema, including every required field and no extra fields.',
        message: 'The course model returned invalid structured output.',
      });
    }
  };

export const generateCourseObject = createCourseObjectGenerator();
