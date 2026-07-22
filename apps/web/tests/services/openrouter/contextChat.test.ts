import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';
import type { FileData } from '../../../types.ts';

const buildReasoningContentForFileMock = vi.fn(async (_file: FileData, prompt: string) => prompt);
const callOpenRouterMock = vi.fn(async () => 'Risposta contestuale');
const retryWithBackoffMock = vi.fn(async <T>(operation: () => Promise<T>) => await operation());

vi.mock('../../../services/openrouter/pdfReasoning.ts', () => ({
  buildReasoningContentForFile: buildReasoningContentForFileMock,
}));

vi.mock('../../../services/openrouter/shared.ts', () => ({
  MODEL_CONTEXT: 'context-model',
  callOpenRouter: callOpenRouterMock,
  retryWithBackoff: retryWithBackoffMock,
}));

const { askContextualQuestion } = await import('../../../services/openrouter/contextChat.ts');

beforeEach(() => {
  buildReasoningContentForFileMock.mockClear();
  callOpenRouterMock.mockClear();
  retryWithBackoffMock.mockClear();
});

test('context chat keeps the complete lesson and explicit selection when a source file exists', async () => {
  const file: FileData = {
    data: 'dGVzdA==',
    mimeType: 'text/plain',
    name: 'source.txt',
  };

  await askContextualQuestion({
    file,
    lessonContent:
      'La prima parte definisce il concetto. La seconda parte mette il passaggio nel suo contesto.',
    lessonDescription: 'Una lezione con due passaggi collegati.',
    lessonTitle: 'Contesto completo',
    selection: 'il passaggio',
    contextBefore: 'mette',
    contextAfter: 'nel suo contesto',
    question: 'Come si collega alla definizione iniziale?',
  });

  const prompt = buildReasoningContentForFileMock.mock.calls[0]?.[1] || '';
  assert.match(
    prompt,
    /La prima parte definisce il concetto\. La seconda parte mette il passaggio nel suo contesto\./
  );
  assert.match(prompt, /PASSAGGIO SELEZIONATO DALL'UTENTE\s+"il passaggio"/);
  assert.match(prompt, /"mette il passaggio nel suo contesto"/);
});
