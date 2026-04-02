import { isTextUIPart, type UIMessage } from 'ai';

export const getUiMessageText = (message: UIMessage) => {
  return message.parts.filter(isTextUIPart).map(part => part.text).join('').trim();
};
