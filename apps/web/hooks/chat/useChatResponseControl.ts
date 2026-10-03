import type { UIMessage } from 'ai';
import { useEffect, useRef, useState } from 'react';

import { translateUiMessage as t } from '../../i18n/uiMessages.ts';

type ChatMessagePart = UIMessage['parts'][number];

export interface ChatToolCallGuard {
  /** False once Stop, a newer message or unmount superseded the response that made this call. */
  readonly isCurrent: () => boolean;
  /** Runs async tool work while Stop can still cancel the call. */
  readonly track: <Result>(work: () => Promise<Result>) => Promise<Result>;
}

export interface ChatResponseControl {
  /** Whether `useChat` may automatically continue the current response. */
  readonly canContinue: () => boolean;
  /** Starts a new response; tool calls from earlier responses become stale. */
  readonly begin: () => void;
  readonly guardToolCall: (toolCall: { toolCallId: string; toolName: string }) => ChatToolCallGuard;
  /** Waits for the previous `send` to settle, begins a new response and runs `start`. */
  readonly send: (start: () => Promise<void>) => Promise<void>;
  /**
   * Stops automatic continuation and returns the tool calls to cancel: every tracked call
   * plus every pending tool part among `parts`, except `completedToolCallId`. Callers
   * write the cancellations after stopping the stream.
   */
  readonly halt: (input: {
    completedToolCallId?: string;
    parts: readonly ChatMessagePart[];
  }) => CancelledToolCall[];
}

export interface CancelledToolCall {
  readonly tool: string;
  readonly toolCallId: string;
}

/** The tool output that settles a cancelled call. */
export const cancelledToolOutput = ({ tool, toolCallId }: CancelledToolCall) => ({
  errorText: t('Annullato'),
  state: 'output-error' as const,
  tool,
  toolCallId,
});

const isPendingToolPart = (
  part: ChatMessagePart
): part is ChatMessagePart & { state: string; toolCallId: string } =>
  'toolCallId' in part && (part.state === 'input-streaming' || part.state === 'input-available');

const readToolPartName = (part: ChatMessagePart): string =>
  'toolName' in part && typeof part.toolName === 'string'
    ? part.toolName
    : part.type.slice('tool-'.length);

/** Parts of the assistant reply that answers the latest user message. */
export const latestResponseParts = (messages: readonly UIMessage[]): ChatMessagePart[] => {
  const latestUserIndex = messages.map(message => message.role).lastIndexOf('user');
  return (
    messages
      .slice(latestUserIndex + 1)
      .reverse()
      .find(message => message.role === 'assistant')?.parts ?? []
  );
};

const createChatResponseControl = (): ChatResponseControl & {
  activate: () => void;
  dispose: () => void;
} => {
  let canContinue = true;
  let generation = 0;
  let pendingSettlement: Promise<void> | undefined;
  const trackedToolCalls = new Map<string, string>();
  const begin = () => {
    canContinue = true;
    generation += 1;
  };
  return {
    canContinue: () => canContinue,
    begin,
    send: async start => {
      if (pendingSettlement !== undefined) await pendingSettlement;
      begin();
      const response = start();
      const settlement = response.then(
        () => undefined,
        () => undefined
      );
      pendingSettlement = settlement;
      try {
        await response;
      } finally {
        if (pendingSettlement === settlement) pendingSettlement = undefined;
      }
    },
    guardToolCall: ({ toolCallId, toolName }) => {
      const callGeneration = generation;
      return {
        isCurrent: () => canContinue && generation === callGeneration,
        track: async work => {
          trackedToolCalls.set(toolCallId, toolName);
          try {
            return await work();
          } finally {
            trackedToolCalls.delete(toolCallId);
          }
        },
      };
    },
    halt: ({ completedToolCallId, parts }) => {
      canContinue = false;
      const pendingToolCalls = new Map(trackedToolCalls);
      for (const part of parts) {
        if (isPendingToolPart(part)) pendingToolCalls.set(part.toolCallId, readToolPartName(part));
      }
      trackedToolCalls.clear();
      pendingToolCalls.delete(completedToolCallId ?? '');
      return [...pendingToolCalls].map(([toolCallId, tool]) => ({ tool, toolCallId }));
    },
    activate: () => {
      canContinue = true;
    },
    dispose: () => {
      canContinue = false;
      generation += 1;
      trackedToolCalls.clear();
    },
  };
};

/**
 * Client-side control of one `useChat` conversation's responses and tool calls. Tool
 * handlers run asynchronously after Stop or a newer message, so each call checks that
 * its response is still current before writing state or tool output.
 */
export const useChatResponseControl = (): ChatResponseControl => {
  const [control] = useState(createChatResponseControl);
  useEffect(() => {
    control.activate();
    return control.dispose;
  }, [control]);
  return control;
};

/**
 * Returns a stable reader of the latest committed value. `useChat` keeps its first
 * transport, so request bodies read their per-request data through this.
 */
export const useLatestValue = <Value>(value: Value): (() => Value) => {
  const latestRef = useRef(value);
  useEffect(() => {
    latestRef.current = value;
  }, [value]);
  const [read] = useState(() => () => latestRef.current);
  return read;
};
