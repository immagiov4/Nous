// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import type { CreateWorkspaceControllerArgs } from '../../../hooks/workspace/controller/types.ts';
import {
  useWorkspaceController,
  type WorkspaceDomainControllerAdapter,
  type WorkspaceProjectLibraryAdapter,
} from '../../../hooks/workspace/useWorkspaceController.ts';

const controllerArgs = vi.hoisted((): CreateWorkspaceControllerArgs[] => []);

vi.mock('../../../hooks/workspace/controller/createWorkspaceController.ts', () => ({
  createWorkspaceController: (args: CreateWorkspaceControllerArgs) => {
    controllerArgs.push(args);
    return {};
  },
}));

test('every controller instance of one mount shares the interview session', () => {
  const projectLibrary = {
    currentProjectId: null,
  } as unknown as WorkspaceProjectLibraryAdapter;
  const { rerender } = renderHook(() =>
    useWorkspaceController({
      domain: {} as WorkspaceDomainControllerAdapter,
      projectLibrary,
      stopAudio: () => {},
    })
  );
  rerender();

  expect(controllerArgs.length).toBeGreaterThanOrEqual(2);
  const [firstRender, ...laterRenders] = controllerArgs;
  for (const args of laterRenders) {
    expect(args.assessmentSession).toBe(firstRender?.assessmentSession);
  }
});
