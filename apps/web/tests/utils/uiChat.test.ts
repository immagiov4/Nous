import assert from 'node:assert/strict';
import type { UIMessage } from 'ai';
import { expect, test } from 'vitest';

import {
  dedupeUiMessagesById,
  getUiMessageRenderableParts,
  getUiMessageText,
  hasOnlySuccessfulToolOutputs,
  hasSuccessfulToolOutput,
} from '../../utils/uiChat.ts';

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
  const assistantMessage = deduped[1];
  assert.ok(assistantMessage);
  assert.equal(getUiMessageText(assistantMessage), 'Certo. Il passaggio sta dicendo di piu.');
});

test('getUiMessageRenderableParts preserves text-tool-text order', () => {
  const message = {
    id: 'assistant-1',
    role: 'assistant',
    parts: [
      { type: 'text', text: 'Prima.', state: 'done' },
      { type: 'tool-requestAddToNotes', toolCallId: 'tool-1', state: 'input-available' },
      { type: 'text', text: 'Dopo.', state: 'streaming' },
    ],
  } as UIMessage;

  const renderableParts = getUiMessageRenderableParts(message);

  assert.deepEqual(
    renderableParts.map(part => part.kind),
    ['text', 'tool', 'text']
  );
  assert.equal(renderableParts[0]?.kind, 'text');
  assert.equal(renderableParts[0]?.text, 'Prima.');
  assert.equal(renderableParts[1]?.kind, 'tool');
  assert.equal(renderableParts[2]?.kind, 'text');
  assert.equal(renderableParts[2]?.text, 'Dopo.');
  assert.equal(renderableParts[2]?.isStreaming, true);
});

test('getUiMessageText removes leaked model placeholders', () => {
  const message = {
    id: 'assistant-1',
    role: 'assistant',
    parts: [
      { type: 'text', text: 'Prima {{attachment id="broken"}} dopo ' },
      { type: 'text', text: '{{visual ignored}} fine' },
    ],
  } as UIMessage;

  assert.equal(getUiMessageText(message), 'Prima  dopo  fine');
});

test('hasSuccessfulToolOutput recognizes a completed artifact generation result', () => {
  const messages = [
    {
      id: 'assistant-1',
      role: 'assistant',
      parts: [
        {
          type: 'tool-generateCurrentLessonArtifact',
          toolCallId: 'tool-1',
          state: 'output-available',
          input: {},
          output: { artifactId: 'artifact-1', renderedArtifactCount: 1 },
        },
      ],
    },
  ] as UIMessage[];

  assert.equal(hasSuccessfulToolOutput(messages, 'tool-generateCurrentLessonArtifact'), true);
});

test('hasSuccessfulToolOutput rejects failed and unrelated tool results', () => {
  const messages = [
    {
      id: 'assistant-1',
      role: 'assistant',
      parts: [
        {
          type: 'tool-generateCurrentLessonArtifact',
          toolCallId: 'tool-1',
          state: 'output-available',
          input: {},
          output: { artifact: null, error: 'generation failed' },
        },
        {
          type: 'tool-getCurrentLessonArtifacts',
          toolCallId: 'tool-2',
          state: 'output-available',
          input: {},
          output: { artifactId: 'artifact-1' },
        },
      ],
    },
  ] as UIMessage[];

  expect(hasSuccessfulToolOutput(messages, 'tool-generateCurrentLessonArtifact')).toBe(false);
});

test('hasOnlySuccessfulToolOutputs allows mixed tool results to continue', () => {
  const generationOnly = [
    {
      id: 'assistant-generation',
      role: 'assistant',
      parts: [
        {
          type: 'tool-generateCurrentLessonArtifact',
          toolCallId: 'tool-generation',
          state: 'output-available',
          input: {},
          output: { artifactId: 'artifact-1' },
        },
      ],
    },
  ] as UIMessage[];
  const mixedTools = [
    {
      ...generationOnly[0],
      id: 'assistant-mixed',
      parts: [
        ...generationOnly[0].parts,
        {
          type: 'tool-searchLibrary',
          toolCallId: 'tool-search',
          state: 'output-available',
          input: { query: 'routing' },
          output: { hits: [] },
        },
      ],
    },
  ] as UIMessage[];

  expect(hasOnlySuccessfulToolOutputs(generationOnly, 'tool-generateCurrentLessonArtifact')).toBe(
    true
  );
  expect(hasOnlySuccessfulToolOutputs(mixedTools, 'tool-generateCurrentLessonArtifact')).toBe(
    false
  );
});
