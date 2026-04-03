import { isTextUIPart, isToolUIPart, type UIMessage } from 'ai';

export const getUiMessageText = (message: UIMessage) => {
  return message.parts.filter(isTextUIPart).map(part => part.text).join('').trim();
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
    if (!textBuffer.trim()) {
      textBuffer = '';
      isStreamingTextBlock = false;
      return;
    }

    renderableParts.push({
      kind: 'text',
      isStreaming: isStreamingTextBlock,
      key: `text-${textBlockIndex}`,
      text: textBuffer,
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
