import type { ProjectRevisionEvent } from './types.js';

type ProjectRevisionListener = (event: ProjectRevisionEvent) => void;

// ponytail: in-process fan-out matches the single backend instance; use shared pub/sub before scaling horizontally.
const listenersByUserId = new Map<string, Set<ProjectRevisionListener>>();

export const publishProjectRevision = (userId: string, event: ProjectRevisionEvent): void => {
  for (const listener of listenersByUserId.get(userId) || []) {
    listener(event);
  }
};

export const subscribeToProjectRevisions = (
  userId: string,
  listener: ProjectRevisionListener
): (() => void) => {
  const listeners = listenersByUserId.get(userId) || new Set<ProjectRevisionListener>();
  listeners.add(listener);
  listenersByUserId.set(userId, listeners);

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      listenersByUserId.delete(userId);
    }
  };
};
