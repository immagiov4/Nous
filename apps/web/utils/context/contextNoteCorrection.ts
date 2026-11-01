import { readContextNoteResult } from '@shared/contextNote';
import type { UIMessage } from 'ai';

/** Only the current completed step can request repair; learner decisions close that path. */
export const readContextNoteCorrection = (messages: readonly UIMessage[]) => {
  const latestUserIndex = messages.map(message => message.role).lastIndexOf('user');
  const response = messages.slice(latestUserIndex + 1);
  const hasFinalDecision = response
    .flatMap(message => message.parts)
    .some(part => {
      if (part.type !== 'tool-requestAddToNotes' || !('output' in part)) return false;
      const result = readContextNoteResult(part.output);
      return result && result.status !== 'validation_error';
    });
  if (hasFinalDecision) return undefined;
  const parts = response.at(-1)?.parts ?? [];
  const lastStepStart = parts.map(part => part.type).lastIndexOf('step-start');
  for (const part of parts.slice(lastStepStart + 1)) {
    if (part.type !== 'tool-requestAddToNotes' || !('output' in part)) continue;
    const result = readContextNoteResult(part.output);
    if (result?.status !== 'validation_error' || result.recovery === 'unavailable') continue;
    if (result.recovery === 'choose_passage' && !result.availablePassageIds?.length) continue;
    return { toolCallId: part.toolCallId, recovery: result.recovery };
  }
  return undefined;
};
