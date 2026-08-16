import { isTextUIPart, isToolUIPart, type UIMessage } from 'ai';

const PLACEHOLDER_START = '{{';
const PLACEHOLDER_END = '}}';

/** Strip internal placeholder syntax like {{attachment ...}} that leaks from some models. */
const stripPlaceholders = (text: string): string => {
  const chunks: string[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    const placeholderStart = text.indexOf(PLACEHOLDER_START, cursor);
    if (placeholderStart === -1) {
      chunks.push(text.slice(cursor));
      break;
    }

    const placeholderEnd = text.indexOf(
      PLACEHOLDER_END,
      placeholderStart + PLACEHOLDER_START.length
    );
    if (placeholderEnd === -1) {
      chunks.push(text.slice(cursor));
      break;
    }

    chunks.push(text.slice(cursor, placeholderStart));
    cursor = placeholderEnd + PLACEHOLDER_END.length;
  }

  return chunks.join('').trim();
};

export const getUiMessageText = (message: UIMessage) => {
  return stripPlaceholders(
    message.parts
      .filter(isTextUIPart)
      .map(part => part.text)
      .join('')
      .trim()
  );
};

type UiMessageRenderablePart<T extends UIMessage = UIMessage> =
  | {
      kind: 'text';
      isStreaming: boolean;
      key: string;
      text: string;
    }
  | {
      kind: 'tool';
      key: string;
      part: T['parts'][number];
    };

export const getUiMessageRenderableParts = <T extends UIMessage>(
  message: T
): UiMessageRenderablePart<T>[] => {
  const renderableParts: UiMessageRenderablePart<T>[] = [];
  let textBuffer = '';
  let isStreamingTextBlock = false;
  let textBlockIndex = 0;

  const flushTextBuffer = () => {
    const cleaned = stripPlaceholders(textBuffer);
    if (!cleaned) {
      textBuffer = '';
      isStreamingTextBlock = false;
      return;
    }

    renderableParts.push({
      kind: 'text',
      isStreaming: isStreamingTextBlock,
      key: `text-${textBlockIndex}`,
      text: cleaned,
    });
    textBlockIndex += 1;
    textBuffer = '';
    isStreamingTextBlock = false;
  };

  message.parts.forEach((part, index) => {
    if (isTextUIPart(part)) {
      textBuffer += part.text;
      isStreamingTextBlock = isStreamingTextBlock || part.state === 'streaming';
      return;
    }

    if (isToolUIPart(part)) {
      flushTextBuffer();
      renderableParts.push({
        kind: 'tool',
        key: `tool-${index}`,
        part,
      });
    }
  });

  flushTextBuffer();
  return renderableParts;
};

export const dedupeUiMessagesById = <T extends UIMessage>(messages: T[]): T[] => {
  const firstIndexById = new Map<string, number>();
  const latestMessageById = new Map<string, T>();
  const passthroughMessages: Array<{ index: number; message: T }> = [];

  messages.forEach((message, index) => {
    const messageId = typeof message.id === 'string' ? message.id : '';

    if (!messageId) {
      passthroughMessages.push({ index, message });
      return;
    }

    if (!firstIndexById.has(messageId)) {
      firstIndexById.set(messageId, index);
    }
    latestMessageById.set(messageId, message);
  });

  return [
    ...Array.from(latestMessageById.entries()).map(([id, message]) => ({
      index: firstIndexById.get(id) ?? Number.MAX_SAFE_INTEGER,
      message,
    })),
    ...passthroughMessages,
  ]
    .sort((left, right) => left.index - right.index)
    .map(item => item.message);
};

/** Keep the latest streamed snapshot for each authoritative tool invocation. */
export const reconcileToolMessageSnapshots = <T extends UIMessage>(messages: T[]): T[] => {
  const latestMessageIndexByToolCallId = new Map<string, number>();
  messages.forEach((message, messageIndex) => {
    for (const part of message.parts) {
      if (isToolUIPart(part)) {
        latestMessageIndexByToolCallId.set(part.toolCallId, messageIndex);
      }
    }
  });

  return messages.flatMap((message, messageIndex) => {
    const currentParts = message.parts.filter(
      part =>
        !isToolUIPart(part) || latestMessageIndexByToolCallId.get(part.toolCallId) === messageIndex
    );
    const hadToolPart = message.parts.some(isToolUIPart);
    if (hadToolPart && !currentParts.some(isToolUIPart)) {
      return [];
    }

    return currentParts.length === message.parts.length
      ? [message]
      : [{ ...message, parts: currentParts } as T];
  });
};

const isSuccessfulToolOutput = (
  part: UIMessage['parts'][number],
  toolPartType: string
): boolean => {
  if (!isToolUIPart(part) || part.type !== toolPartType || part.state !== 'output-available') {
    return false;
  }
  const output = part.output;
  return Boolean(
    output && typeof output === 'object' && 'artifactId' in output && output.artifactId
  );
};

export const hasSuccessfulToolOutput = (messages: UIMessage[], toolPartType: string): boolean => {
  const lastMessage = messages.at(-1);
  return lastMessage?.role === 'assistant'
    ? lastMessage.parts.some(part => isSuccessfulToolOutput(part, toolPartType))
    : false;
};

export const hasOnlySuccessfulToolOutputs = (
  messages: UIMessage[],
  toolPartType: string
): boolean => {
  const lastMessage = messages.at(-1);
  if (lastMessage?.role !== 'assistant') {
    return false;
  }

  const toolParts = lastMessage.parts.filter(isToolUIPart);
  return (
    toolParts.length > 0 && toolParts.every(part => isSuccessfulToolOutput(part, toolPartType))
  );
};
