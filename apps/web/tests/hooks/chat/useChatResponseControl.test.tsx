// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import type { UIMessage } from 'ai';
import { expect, test } from 'vitest';

import {
  latestResponseParts,
  useChatResponseControl,
} from '../../../hooks/chat/useChatResponseControl.ts';

const toolPart = (toolCallId: string, state: string) =>
  ({ input: {}, state, toolCallId, type: 'tool-search' }) as UIMessage['parts'][number];

test('a tool call becomes stale after Stop, a newer response or unmount', () => {
  const { result, unmount } = renderHook(() => useChatResponseControl());
  const control = result.current;

  const first = control.guardToolCall({ toolCallId: 'a', toolName: 'search' });
  expect(first.isCurrent()).toBe(true);
  control.begin();
  expect(first.isCurrent()).toBe(false);

  const second = control.guardToolCall({ toolCallId: 'b', toolName: 'search' });
  control.halt({ parts: [] });
  expect(second.isCurrent()).toBe(false);
  expect(control.canContinue()).toBe(false);

  control.begin();
  const third = control.guardToolCall({ toolCallId: 'c', toolName: 'search' });
  unmount();
  expect(third.isCurrent()).toBe(false);
});

test('halt cancels tracked and pending calls except the completed one', async () => {
  const { result } = renderHook(() => useChatResponseControl());
  const control = result.current;
  let finishTracked: () => void = () => {};
  const tracked = control
    .guardToolCall({ toolCallId: 'tracked', toolName: 'generate' })
    .track(() => new Promise<void>(resolve => (finishTracked = resolve)));

  const cancelled = control.halt({
    completedToolCallId: 'handoff',
    parts: [
      toolPart('pending', 'input-available'),
      toolPart('handoff', 'input-available'),
      toolPart('done', 'output-available'),
    ],
  });

  expect(cancelled).toEqual([
    { tool: 'generate', toolCallId: 'tracked' },
    { tool: 'search', toolCallId: 'pending' },
  ]);
  finishTracked();
  await tracked;
  expect(control.halt({ parts: [] })).toEqual([]);
});

test('send waits for the previous response before starting the next', async () => {
  const { result } = renderHook(() => useChatResponseControl());
  const control = result.current;
  const order: string[] = [];
  let finishFirst: () => void = () => {};

  const first = control.send(() => {
    order.push('first');
    return new Promise<void>(resolve => (finishFirst = resolve));
  });
  const second = control.send(async () => {
    order.push('second');
  });
  await Promise.resolve();
  expect(order).toEqual(['first']);

  finishFirst();
  await Promise.all([first, second]);
  expect(order).toEqual(['first', 'second']);
});

test('the latest response is the assistant reply after the last user message', () => {
  const messages = [
    { id: '1', parts: [toolPart('old', 'input-available')], role: 'assistant' },
    { id: '2', parts: [], role: 'user' },
    { id: '3', parts: [toolPart('new', 'input-available')], role: 'assistant' },
  ] as UIMessage[];

  expect(latestResponseParts(messages)).toEqual([toolPart('new', 'input-available')]);
});

test('sends queued behind one response start one at a time', async () => {
  const { result } = renderHook(() => useChatResponseControl());
  const control = result.current;
  const order: string[] = [];
  const finishers: Array<() => void> = [];
  const queuedSend = (name: string) =>
    control.send(() => {
      order.push(name);
      return new Promise<void>(resolve => finishers.push(resolve));
    });

  const sends = [queuedSend('first'), queuedSend('second'), queuedSend('third')];
  await Promise.resolve();
  expect(order).toEqual(['first']);

  finishers[0]?.();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(order).toEqual(['first', 'second']);

  finishers[1]?.();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(order).toEqual(['first', 'second', 'third']);
  finishers[2]?.();
  await Promise.all(sends);
});
