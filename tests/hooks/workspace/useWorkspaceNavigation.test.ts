import assert from 'node:assert/strict';
import { test } from 'vitest';
import { AppState } from '../../../types.ts';
import { shouldOpenProjectFromLocation } from '../../../hooks/workspace/useWorkspaceNavigation.ts';

test('does not reopen the current project while returning internally to the library', () => {
  assert.equal(
    shouldOpenProjectFromLocation({
      currentProjectId: 'project-123',
      hasPendingExternalLocation: false,
      locationProjectId: 'project-123',
      openingProjectId: null,
      screenState: AppState.LIBRARY,
    }),
    false
  );
});

test('reopens the project from location when the browser navigation is external', () => {
  assert.equal(
    shouldOpenProjectFromLocation({
      currentProjectId: 'project-123',
      hasPendingExternalLocation: true,
      locationProjectId: 'project-123',
      openingProjectId: null,
      screenState: AppState.LIBRARY,
    }),
    true
  );
});

test('does not reopen a project that is already active in reading mode', () => {
  assert.equal(
    shouldOpenProjectFromLocation({
      currentProjectId: 'project-123',
      hasPendingExternalLocation: false,
      locationProjectId: 'project-123',
      openingProjectId: null,
      screenState: AppState.READING,
    }),
    false
  );
});
