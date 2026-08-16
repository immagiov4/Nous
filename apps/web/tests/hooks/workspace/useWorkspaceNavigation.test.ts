// @vitest-environment jsdom

import assert from 'node:assert/strict';
import { act, renderHook } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import {
  shouldOpenProjectFromLocation,
  useWorkspaceNavigation,
} from '../../../hooks/workspace/useWorkspaceNavigation.ts';
import { AppState } from '../../../types.ts';

type HookArgs = Parameters<typeof useWorkspaceNavigation>[0];

const buildHookArgs = (overrides: Partial<HookArgs> = {}): HookArgs => ({
  currentProjectId: 'project-1',
  isLibraryLoading: false,
  notifyError: vi.fn(),
  onCloseContextAnswer: vi.fn(),
  onGoToLibrary: vi.fn(async () => undefined),
  onOpenProject: vi.fn(async () => ({ outcome: 'opened' })),
  openingProjectId: null,
  screenState: AppState.READING,
  setIsFocusMode: vi.fn(),
  setIsMobileSidebarOpen: vi.fn(),
  ...overrides,
});

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

test('closes a retained contextual answer on ordinary reader exit', () => {
  const onCloseContextAnswer = vi.fn();
  const { result } = renderHook(() =>
    useWorkspaceNavigation(buildHookArgs({ onCloseContextAnswer }))
  );

  act(() => {
    result.current.handleBackToLibrary();
  });

  expect(onCloseContextAnswer).toHaveBeenCalledTimes(1);
});

test('retains a contextual answer only for recovered-reference project navigation', async () => {
  const onCloseContextAnswer = vi.fn();
  const onOpenProject = vi.fn(async () => ({ outcome: 'opened' }));
  const { result } = renderHook(() =>
    useWorkspaceNavigation(buildHookArgs({ onCloseContextAnswer, onOpenProject }))
  );

  await act(async () => {
    await result.current.handleOpenProject('project-2', { source: 'library' });
  });
  expect(onCloseContextAnswer).not.toHaveBeenCalled();

  await act(async () => {
    await result.current.handleOpenProject('project-3', { source: 'route' });
  });
  expect(onCloseContextAnswer).toHaveBeenCalledTimes(1);
});

test.each([
  'missing',
  'failed',
  'stale',
] as const)('keeps a retained contextual answer when route project navigation returns %s', async outcome => {
  const onCloseContextAnswer = vi.fn();
  const onOpenProject = vi.fn(async () => ({ outcome }));
  const { result } = renderHook(() =>
    useWorkspaceNavigation(buildHookArgs({ onCloseContextAnswer, onOpenProject }))
  );

  await act(async () => {
    await result.current.handleOpenProject('project-2', { source: 'route' });
  });

  expect(onCloseContextAnswer).not.toHaveBeenCalled();
});
