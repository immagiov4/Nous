import { TRANSCRIBED_SOURCE_RULE } from '@shared/pdfTranscription';
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
import { prepareStrictStructuredOutput } from '../services/strictStructuredOutput.js';
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
    role: input.name,
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
  const strictOutput = prepareStrictStructuredOutput(outputSchema);
  if (resolveAiProviderForSlot(config, input.slot) !== 'codex') {
    const response = await dependencies.runAiObject({
      config,
      developerInstructions: `${input.developerInstructions}\n${TRANSCRIBED_SOURCE_RULE}`,
      name: input.name,
      outputSchema: strictOutput.schema,
      prompt: input.prompt,
      signal: input.signal,
      slot: input.slot,
      ...(input.maxToolSteps === undefined ? {} : { maxToolSteps: input.maxToolSteps }),
      ...(input.tools ? { tools: input.tools } : {}),
      webSearch,
    });
    return strictOutput.normalize(response);
  }

  const model = resolveTextModelConfig(config, input.slot);
  const response = await dependencies.runCodexObject({
    allowWebSearch: webSearch,
    developerInstructions: `${input.developerInstructions}\n${TRANSCRIBED_SOURCE_RULE}`,
    input: [{ text: input.prompt, type: 'text' }],
    model: model.model,
    slot: input.slot,
    role: input.name,
    outputSchemaName: input.name,
    outputSchema: strictOutput.schema,
    reasoningEffort: model.reasoningEffort,
    serviceTier: resolveCodexServiceTierForSlot(config, input.slot),
    signal: input.signal,
    ...(input.tools
      ? { tools: toCodexTools(input.tools, input.maxToolSteps) as CodexTurnTool[] }
      : {}),
  });
  return strictOutput.normalize(JSON.parse(response));
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
