import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';
import { buildCourseSourceDescriptors } from '../../../services/projects/courseSources.ts';
import { encodeTextBase64 } from '../../../services/projects/projectSource.ts';

const callOpenRouterMock = vi.fn();

vi.mock('../../../services/openrouter/shared.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../services/openrouter/shared.ts')>();
  return {
    ...actual,
    callOpenRouter: callOpenRouterMock,
    MODEL_ASSESSMENT: 'assessment-model',
  };
});

const { createAssessmentChatFromSourceSet } = await import(
  '../../../services/openrouter/assessment.ts'
);

beforeEach(() => {
  callOpenRouterMock.mockReset();
});

test('multi-source assessment sends every independent source index to the interviewer', async () => {
  const sources = buildCourseSourceDescriptors([
    {
      name: 'fondamenti.md',
      mimeType: 'text/markdown',
      data: encodeTextBase64('# Fondamenti\nConcetti di base.'),
    },
    {
      name: 'casi.txt',
      mimeType: 'text/plain',
      data: encodeTextBase64('Applicazioni e casi di studio.'),
    },
  ]);
  callOpenRouterMock.mockResolvedValue('Quale parte conosci gia?');

  const session = await createAssessmentChatFromSourceSet(sources);
  await session.sendMessage({ message: 'Parto da zero.' });

  const requestMessages = callOpenRouterMock.mock.calls[0]?.[0]?.messages || [];
  const sourceMessage = String(requestMessages[1]?.content || '');
  assert.ok(sources.every(source => sourceMessage.includes(source.id)));
  assert.ok(sourceMessage.includes('Concetti di base.'));
  assert.ok(sourceMessage.includes('Applicazioni e casi di studio.'));
  assert.ok(
    requestMessages.some(
      (message: { content?: unknown; role?: string }) =>
        message.role === 'user' && message.content === 'Parto da zero.'
    )
  );
});
