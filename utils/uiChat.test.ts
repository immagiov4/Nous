import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { UIMessage } from 'ai';

import { dedupeUiMessagesById, getUiMessageText } from './uiChat.ts';

test('dedupeUiMessagesById keeps only the latest snapshot for each message id', () => {
  const messages = [
    {
      id: 'user-1',
      role: 'user',
      parts: [{ type: 'text', text: 'spiega meglio' }],
    },
    {
      id: 'assistant-1',
      role: 'assistant',
      parts: [{ type: 'text', text: 'Certo.' }],
    },
    {
      id: 'assistant-1',
      role: 'assistant',
      parts: [{ type: 'text', text: 'Certo. Il passaggio sta dicendo di piu.' }],
    },
    {
      id: 'user-1',
      role: 'user',
      parts: [{ type: 'text', text: 'spiega meglio' }],
    },
  ] as UIMessage[];

  const deduped = dedupeUiMessagesById(messages);

  assert.equal(deduped.length, 2);
  assert.deepEqual(
    deduped.map(message => message.id),
    ['user-1', 'assistant-1']
  );
  assert.equal(getUiMessageText(deduped[1]!), 'Certo. Il passaggio sta dicendo di piu.');
});
