import type { ProjectRevisionEvent } from './types.js';

type ProjectRevisionListener = (event: ProjectRevisionEvent) => void;
type ProjectRevisionCatchUpListener = () => void;

// Process-local SSE sink; workflow revision wakes enter every replica through the PostgreSQL inbox.
const listenersByUserId = new Map<string, Set<ProjectRevisionListener>>();
const catchUpListeners = new Set<ProjectRevisionCatchUpListener>();

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

export const requestProjectRevisionCatchUp = (): void => {
  for (const listener of catchUpListeners) {
    listener();
  }
};

export const subscribeToProjectRevisionCatchUps = (
  listener: ProjectRevisionCatchUpListener
): (() => void) => {
  catchUpListeners.add(listener);
  return () => catchUpListeners.delete(listener);
};
