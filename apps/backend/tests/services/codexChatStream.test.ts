import { jsonSchema, tool } from 'ai';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { CodexTurnInput } from '../../src/services/codexAppServer.js';

const codexMocks = vi.hoisted(() => ({
  runCodexAppServerTurn: vi.fn(),
}));

vi.mock('../../src/services/codexAppServer.js', () => codexMocks);

const { createCodexChatStream, SAFE_AI_STREAM_ERROR } = await import(
  '../../src/services/codexChatStream.js'
);

const readStreamChunks = async (stream: ReadableStream): Promise<Record<string, unknown>[]> => {
  const chunks: Record<string, unknown>[] = [];
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      return chunks;
    }
    chunks.push(value as Record<string, unknown>);
  }
};

describe('Codex UI message adapter', () => {
  beforeEach(() => {
    codexMocks.runCodexAppServerTurn.mockReset();
  });

  test('propagates client-executed dynamic tools without pretending the provider executed them', async () => {
    codexMocks.runCodexAppServerTurn.mockImplementation(async (turn: CodexTurnInput) => {
      expect(turn.tools).toEqual([
        expect.objectContaining({
          name: 'requestAddToNotes',
          inputSchema: expect.objectContaining({ type: 'object' }),
        }),
      ]);
      expect(turn.tools[0].execute).toBeUndefined();
      turn.onToolStart?.('call-note-1', 'requestAddToNotes', { noteDraft: 'Nota utile' }, 'client');
      return '';
    });

    const stream = await createCodexChatStream({
      messages: [{ role: 'user', content: 'Salva questa nota.' }],
      model: 'gpt-test',
      reasoningEffort: 'medium',
      system: 'Agisci come tutor.',
      tools: {
        requestAddToNotes: tool({
          description: 'Propone una nota nel client.',
          inputSchema: jsonSchema({
            type: 'object',
            properties: { noteDraft: { type: 'string' } },
            required: ['noteDraft'],
          }),
        }),
      },
    });
    const chunks = await readStreamChunks(stream);

    expect(chunks).toContainEqual({
      type: 'tool-input-available',
      toolCallId: 'call-note-1',
      toolName: 'requestAddToNotes',
      input: { noteDraft: 'Nota utile' },
      dynamic: true,
    });
    expect(chunks.some(chunk => chunk.type === 'tool-output-available')).toBe(false);
    expect(chunks).toContainEqual({ type: 'finish', finishReason: 'tool-calls' });
  });

  test('uses completed text when no deltas arrive and exposes only stable stream errors', async () => {
    codexMocks.runCodexAppServerTurn.mockResolvedValueOnce('Prima\n\nseconda');
    const completedStream = await createCodexChatStream({
      messages: [{ role: 'user', content: 'Ciao' }],
      model: 'gpt-test',
      reasoningEffort: 'low',
      system: 'Tutor.',
      tools: {},
    });
    const completedChunks = await readStreamChunks(completedStream);
    expect(completedChunks).toContainEqual({
      type: 'text-delta',
      id: 'codex-answer',
      delta: 'Prima\n\nseconda',
    });

    codexMocks.runCodexAppServerTurn.mockRejectedValueOnce(
      new Error('C:\\Users\\reader\\.codex\\auth.json token=secret')
    );
    const failedStream = await createCodexChatStream({
      messages: [{ role: 'user', content: 'Ciao' }],
      model: 'gpt-test',
      reasoningEffort: 'low',
      system: 'Tutor.',
      tools: {},
    });
    const failedChunks = await readStreamChunks(failedStream);

    expect(failedChunks).toContainEqual({ type: 'error', errorText: SAFE_AI_STREAM_ERROR });
    expect(JSON.stringify(failedChunks)).not.toContain('auth.json');
    expect(failedChunks.some(chunk => chunk.type === 'finish')).toBe(false);
  });
});
