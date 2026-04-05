// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';

import LibraryTreeView from '../../../components/library/LibraryTreeView.tsx';
import type { LibraryTree, SavedProjectMeta } from '../../../types.ts';

const project: SavedProjectMeta = {
  id: 'project-1',
  title: 'Corso Mobile',
  sourceKind: 'document',
  createdAt: '2026-04-04T10:00:00.000Z',
  updatedAt: '2026-04-04T10:00:00.000Z',
  lastOpenedAt: '2026-04-04T10:00:00.000Z',
  lessonCount: 3,
  completedCount: 1,
  hasSourceFile: true,
  coverLabel: 'PDF',
  syncState: 'local-only',
};

const tree: LibraryTree = {
  descendantProjectIdsByFolderId: {
    'folder-1': ['project-1'],
  },
  folderById: {
    'folder-1': {
      id: 'folder-1',
      name: 'Frontend',
      parentFolderId: null,
      createdAt: '2026-04-04T10:00:00.000Z',
      updatedAt: '2026-04-04T10:00:00.000Z',
      order: 1,
    },
  },
  placementByProjectId: {
    'project-1': {
      projectId: 'project-1',
      folderId: 'folder-1',
      order: 1,
      updatedAt: '2026-04-04T10:00:00.000Z',
    },
  },
  rootNodes: [
    {
      id: 'folder-1',
      kind: 'folder',
      order: 1,
      folder: {
        id: 'folder-1',
        name: 'Frontend',
        parentFolderId: null,
        createdAt: '2026-04-04T10:00:00.000Z',
        updatedAt: '2026-04-04T10:00:00.000Z',
        order: 1,
      },
      descendantProjectIds: ['project-1'],
      children: [
        {
          id: 'project-1',
          kind: 'project',
          order: 1,
          project,
        },
      ],
    },
  ],
};

const desktopProject: SavedProjectMeta = {
  id: 'project-2',
  title: 'Corso Desktop',
  sourceKind: 'document',
  createdAt: '2026-04-04T11:00:00.000Z',
  updatedAt: '2026-04-04T11:00:00.000Z',
  lastOpenedAt: '2026-04-04T11:00:00.000Z',
  lessonCount: 2,
  completedCount: 0,
  hasSourceFile: true,
  coverLabel: 'PDF',
  syncState: 'local-only',
};

const desktopTree: LibraryTree = {
  descendantProjectIdsByFolderId: {},
  folderById: {
    'folder-2': {
      id: 'folder-2',
      name: 'Backend',
      parentFolderId: null,
      createdAt: '2026-04-04T11:00:00.000Z',
      updatedAt: '2026-04-04T11:00:00.000Z',
      order: 2,
    },
  },
  placementByProjectId: {
    'project-2': {
      projectId: 'project-2',
      folderId: null,
      order: 1,
      updatedAt: '2026-04-04T11:00:00.000Z',
    },
  },
  rootNodes: [
    {
      id: 'project-2',
      kind: 'project',
      order: 1,
      project: desktopProject,
    },
    {
      id: 'folder-2',
      kind: 'folder',
      order: 2,
      folder: {
        id: 'folder-2',
        name: 'Backend',
        parentFolderId: null,
        createdAt: '2026-04-04T11:00:00.000Z',
        updatedAt: '2026-04-04T11:00:00.000Z',
        order: 2,
      },
      descendantProjectIds: [],
      children: [],
    },
  ],
};

const originalMatchMedia = window.matchMedia;

describe('LibraryTreeView', () => {
  afterEach(() => {
    window.matchMedia = originalMatchMedia;
  });

  test('mounts correctly with legacy MediaQueryList listeners used by mobile Safari', () => {
    const addListener = vi.fn();
    const removeListener = vi.fn();

    window.matchMedia = vi.fn().mockReturnValue({
      matches: true,
      media: '(max-width: 767px)',
      onchange: null,
      addListener,
      removeListener,
      dispatchEvent: vi.fn(),
    });

    const { unmount } = render(
      <LibraryTreeView
        openingProjectId={null}
        onCreateFolder={vi.fn(async () => {})}
        onDeleteFolder={vi.fn(async () => {})}
        onDeleteProject={vi.fn()}
        onExportProject={vi.fn()}
        onMoveFolder={vi.fn(async () => {})}
        onMoveProjects={vi.fn(async () => {})}
        onOpenProject={vi.fn()}
        onRenameFolder={vi.fn(async () => {})}
        tree={tree}
      />
    );

    expect(screen.getByText('Frontend')).toBeInTheDocument();
    expect(addListener).toHaveBeenCalledTimes(1);

    unmount();

    expect(removeListener).toHaveBeenCalledTimes(1);
  });

  test('drops a folder before a root project instead of always appending it below', () => {
    const onMoveFolder = vi.fn(async () => null);

    render(
      <LibraryTreeView
        openingProjectId={null}
        onCreateFolder={vi.fn(async () => {})}
        onDeleteFolder={vi.fn(async () => {})}
        onDeleteProject={vi.fn()}
        onExportProject={vi.fn()}
        onMoveFolder={onMoveFolder}
        onMoveProjects={vi.fn(async () => [])}
        onOpenProject={vi.fn()}
        onRenameFolder={vi.fn(async () => {})}
        tree={desktopTree}
      />
    );

    const draggedFolder = screen.getByText('Backend').closest('[draggable="true"]');
    const dropTarget = screen.getByText('Corso Desktop').closest('[draggable="true"]');

    expect(draggedFolder).toBeTruthy();
    expect(dropTarget).toBeTruthy();

    Object.defineProperty(dropTarget as HTMLElement, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        bottom: 80,
        height: 80,
        left: 0,
        right: 320,
        top: 0,
        width: 320,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }),
    });

    fireEvent.dragStart(draggedFolder as HTMLElement);

    const dragOverEvent = new Event('dragover', {
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(dragOverEvent, 'clientY', {
      configurable: true,
      value: 10,
    });
    fireEvent(dropTarget as HTMLElement, dragOverEvent);

    const dropEvent = new Event('drop', {
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(dropEvent, 'clientY', {
      configurable: true,
      value: 10,
    });
    fireEvent(dropTarget as HTMLElement, dropEvent);

    expect(onMoveFolder).toHaveBeenCalledWith('folder-2', null, 0);
  });
});
