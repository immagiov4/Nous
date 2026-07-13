import {
  asSchema,
  createUIMessageStream,
  type ModelMessage,
  type ToolSet,
  type UIMessage,
} from 'ai';

import type { ReasoningEffort } from '../config/modelConfig.js';
import { type CodexTurnTool, runCodexAppServerTurn } from './codexAppServer.js';

interface CodexChatStreamInput {
  messages: ModelMessage[];
  model: string;
  reasoningEffort: ReasoningEffort;
  system: string;
  tools: ToolSet;
}

const CODEX_TEXT_PART_ID = 'codex-answer';
const CODEX_CLIENT_TOOL_INSTRUCTIONS =
  'When calling a client tool, call it directly without announcing, narrating, or previewing the action in user-visible text. If it returns status "awaiting_client_result", end the turn immediately without inventing its result. Nous will send the real client result in the next turn. Continue from that result without repeating any text already sent in earlier turns.';
export const SAFE_AI_STREAM_ERROR =
  'Il servizio AI non ha completato la richiesta. Riprova tra poco.';

const formatMessageContent = (content: unknown): string => {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return JSON.stringify(content);
  }

  return content
    .map(part => {
      if (
        part &&
        typeof part === 'object' &&
        'type' in part &&
        part.type === 'text' &&
        'text' in part
      ) {
        return String(part.text);
      }
      return JSON.stringify(part);
    })
    .join('\n');
};

const formatConversation = (messages: ModelMessage[]): string =>
  messages
    .map(message => `${message.role.toUpperCase()}:\n${formatMessageContent(message.content)}`)
    .join('\n\n');

const resolveToolOutput = async (output: unknown): Promise<unknown> => {
  const resolved = await output;
  if (!resolved || typeof resolved !== 'object' || !(Symbol.asyncIterator in resolved)) {
    return resolved;
  }

  let lastValue: unknown;
  for await (const value of resolved as AsyncIterable<unknown>) {
    lastValue = value;
  }
  return lastValue;
};

const buildCodexTools = async (
  tools: ToolSet,
  messages: ModelMessage[]
): Promise<CodexTurnTool[]> => {
  const result: CodexTurnTool[] = [];

  for (const [name, tool] of Object.entries(tools)) {
    if (tool.type === 'provider') {
      continue;
    }

    const schema = asSchema(tool.inputSchema);
    const inputSchema = await schema.jsonSchema;
    const execute = tool.execute;
    result.push({
      name,
      description: tool.description || name,
      inputSchema: inputSchema as Record<string, unknown>,
      ...(execute
        ? {
            execute: async (argumentsValue: unknown, callId: string) => {
              const validation = schema.validate ? await schema.validate(argumentsValue) : null;
              if (validation && !validation.success) {
                throw validation.error;
              }
              const input = validation?.success ? validation.value : argumentsValue;
              return resolveToolOutput(
                execute(input as never, {
                  toolCallId: callId,
                  messages,
                })
              );
            },
          }
        : {}),
    });
  }

  return result;
};

export const createCodexChatStream = async ({
  messages,
  model,
  reasoningEffort,
  system,
  tools,
}: CodexChatStreamInput) => {
  const codexTools = await buildCodexTools(tools, messages);
  const developerInstructions = codexTools.some(tool => !tool.execute)
    ? `${system}\n\n${CODEX_CLIENT_TOOL_INSTRUCTIONS}`
    : system;

  return createUIMessageStream<UIMessage>({
    onError: () => SAFE_AI_STREAM_ERROR,
    execute: async ({ writer }) => {
      let clientToolCalled = false;
      let streamedText = '';
      let succeeded = false;
      writer.write({ type: 'start' });
      writer.write({ type: 'start-step' });
      writer.write({ type: 'text-start', id: CODEX_TEXT_PART_ID });

      try {
        const completedText = await runCodexAppServerTurn({
          developerInstructions,
          input: [{ type: 'text', text: formatConversation(messages) }],
          model,
          reasoningEffort,
          tools: codexTools,
          onTextDelta: delta => {
            streamedText += delta;
            writer.write({ type: 'text-delta', id: CODEX_TEXT_PART_ID, delta });
          },
          onToolStart: (callId, name, input, execution) => {
            clientToolCalled ||= execution === 'client';
            writer.write({
              type: 'tool-input-available',
              toolCallId: callId,
              toolName: name,
              input,
              dynamic: false,
              ...(execution === 'server' ? { providerExecuted: true } : {}),
            });
          },
          onToolEnd: (callId, output) =>
            writer.write({
              type: 'tool-output-available',
              toolCallId: callId,
              output,
              dynamic: false,
              providerExecuted: true,
            }),
        });
        if (!streamedText && completedText) {
          writer.write({ type: 'text-delta', id: CODEX_TEXT_PART_ID, delta: completedText });
        }
        succeeded = true;
      } finally {
        writer.write({ type: 'text-end', id: CODEX_TEXT_PART_ID });
        writer.write({ type: 'finish-step' });
        if (succeeded) {
          writer.write({ type: 'finish', finishReason: clientToolCalled ? 'tool-calls' : 'stop' });
        }
      }
    },
  });
};
