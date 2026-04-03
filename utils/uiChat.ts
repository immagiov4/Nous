import { isTextUIPart, type UIMessage } from 'ai';

export const getUiMessageText = (message: UIMessage) => {
  return message.parts.filter(isTextUIPart).map(part => part.text).join('').trim();
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
