import { expect, test, vi } from 'vitest';

import {
  publishProjectRevision,
  subscribeToProjectRevisions,
} from '../../src/projects/projectEvents.js';

test('project revision events reach every session for the same user and no other user', () => {
  const firstSession = vi.fn();
  const secondSession = vi.fn();
  const otherUserSession = vi.fn();
  const unsubscribeFirst = subscribeToProjectRevisions('user-1', firstSession);
  const unsubscribeSecond = subscribeToProjectRevisions('user-1', secondSession);
  const unsubscribeOther = subscribeToProjectRevisions('user-2', otherUserSession);
  const event = { projectId: 'project-1', revision: 7 };

  publishProjectRevision('user-1', event);

  expect(firstSession).toHaveBeenCalledWith(event);
  expect(secondSession).toHaveBeenCalledWith(event);
  expect(otherUserSession).not.toHaveBeenCalled();

  unsubscribeFirst();
  unsubscribeSecond();
  unsubscribeOther();
});
