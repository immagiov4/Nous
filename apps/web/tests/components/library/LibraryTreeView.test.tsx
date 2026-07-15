// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  waitForElementToBeRemoved,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

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
  exerciseCount: 0,
  completedExercises: 0,
  hasSourceFile: true,
  coverLabel: 'PDF',
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
  exerciseCount: 0,
  completedExercises: 0,
  hasSourceFile: true,
  coverLabel: 'PDF',
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
  beforeEach(() => {
    window.localStorage.clear();
  });

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
        onConfirmDeleteFolder={vi.fn(async () => true)}
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
    expect(addListener).toHaveBeenCalled();

    unmount();

    expect(removeListener).toHaveBeenCalledTimes(addListener.mock.calls.length);
  });

  test('opens the root folder form when the external trigger increments', async () => {
    const props = {
      openingProjectId: null,
      onCreateFolder: vi.fn(async () => {}),
      onConfirmDeleteFolder: vi.fn(async () => true),
      onDeleteFolder: vi.fn(async () => {}),
      onDeleteProject: vi.fn(),
      onExportProject: vi.fn(),
      onMoveFolder: vi.fn(async () => {}),
      onMoveProjects: vi.fn(async () => []),
      onOpenProject: vi.fn(),
      onRenameFolder: vi.fn(async () => {}),
      tree,
    };
    const { rerender } = render(<LibraryTreeView {...props} createRootTrigger={0} />);

    expect(screen.queryByPlaceholderText('Nome cartella...')).not.toBeInTheDocument();

    rerender(<LibraryTreeView {...props} createRootTrigger={1} />);

    expect(await screen.findByPlaceholderText('Nome cartella...')).toBeInTheDocument();
  });

  test('drops a folder before a root project instead of always appending it below', () => {
    const onMoveFolder = vi.fn(async () => null);

    render(
      <LibraryTreeView
        openingProjectId={null}
        onCreateFolder={vi.fn(async () => {})}
        onConfirmDeleteFolder={vi.fn(async () => true)}
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

  test('persists collapsed folders across remounts', async () => {
    const user = (await import('@testing-library/user-event')).default.setup();

    const { container, unmount } = render(
      <LibraryTreeView
        openingProjectId={null}
        onCreateFolder={vi.fn(async () => {})}
        onConfirmDeleteFolder={vi.fn(async () => true)}
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

    await user.click(screen.getByTitle('Chiudi cartella'));

    const exitingFolderChildren = container.querySelector('[data-folder-children-id="folder-1"]');
    expect(exitingFolderChildren).toHaveAttribute('aria-hidden', 'true');
    expect(exitingFolderChildren).toHaveAttribute('inert');
    await waitForElementToBeRemoved(() => screen.queryByText('Corso Mobile'));

    unmount();

    render(
      <LibraryTreeView
        openingProjectId={null}
        onCreateFolder={vi.fn(async () => {})}
        onConfirmDeleteFolder={vi.fn(async () => true)}
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

    expect(screen.queryByText('Corso Mobile')).not.toBeInTheDocument();
    expect(screen.getByTitle('Apri cartella')).toBeInTheDocument();
  });

  test('keeps folder child content outside the folder drag surface', () => {
    render(
      <LibraryTreeView
        openingProjectId={null}
        onCreateFolder={vi.fn(async () => {})}
        onConfirmDeleteFolder={vi.fn(async () => true)}
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

    const folderContent = screen.getByLabelText('Contenuto cartella Frontend');

    expect(folderContent.closest('[draggable="true"]')).toBeNull();
  });

  test('uses the same vertical spacing inside expanded folders as the root list', () => {
    render(
      <LibraryTreeView
        openingProjectId={null}
        onCreateFolder={vi.fn(async () => {})}
        onConfirmDeleteFolder={vi.fn(async () => true)}
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
  });

  test('keeps an opening project clickable so a stale opening state can be retried', async () => {
    const user = (await import('@testing-library/user-event')).default.setup();
    const onOpenProject = vi.fn();

    render(
      <LibraryTreeView
        openingProjectId="project-1"
        onCreateFolder={vi.fn(async () => {})}
        onConfirmDeleteFolder={vi.fn(async () => true)}
        onDeleteFolder={vi.fn(async () => {})}
        onDeleteProject={vi.fn()}
        onExportProject={vi.fn()}
        onMoveFolder={vi.fn(async () => {})}
        onMoveProjects={vi.fn(async () => {})}
        onOpenProject={onOpenProject}
        onRenameFolder={vi.fn(async () => {})}
        tree={tree}
      />
    );

    await user.click(screen.getByText('Corso Mobile'));

    expect(onOpenProject).toHaveBeenCalledWith('project-1');
  });

  test('drops a nested project into the library root drop zone', () => {
    const onMoveProjects = vi.fn(async () => []);

    render(
      <LibraryTreeView
        openingProjectId={null}
        onCreateFolder={vi.fn(async () => {})}
        onConfirmDeleteFolder={vi.fn(async () => true)}
        onDeleteFolder={vi.fn(async () => {})}
        onDeleteProject={vi.fn()}
        onExportProject={vi.fn()}
        onMoveFolder={vi.fn(async () => {})}
        onMoveProjects={onMoveProjects}
        onOpenProject={vi.fn()}
        onRenameFolder={vi.fn(async () => {})}
        tree={tree}
      />
    );

    const draggedProject = screen.getByText('Corso Mobile').closest('[draggable="true"]');
    expect(draggedProject).toBeTruthy();

    fireEvent.dragStart(draggedProject as HTMLElement);

    const rootDropZone = screen.getByLabelText('Sposta nella radice libreria');
    fireEvent.dragOver(rootDropZone);
    fireEvent.drop(rootDropZone);

    expect(onMoveProjects).toHaveBeenCalledWith(['project-1'], null, 1);
  });

  test('drops a nested project into the library root from empty library space', () => {
    const onMoveProjects = vi.fn(async () => []);

    const { container } = render(
      <LibraryTreeView
        openingProjectId={null}
        onCreateFolder={vi.fn(async () => {})}
        onConfirmDeleteFolder={vi.fn(async () => true)}
        onDeleteFolder={vi.fn(async () => {})}
        onDeleteProject={vi.fn()}
        onExportProject={vi.fn()}
        onMoveFolder={vi.fn(async () => {})}
        onMoveProjects={onMoveProjects}
        onOpenProject={vi.fn()}
        onRenameFolder={vi.fn(async () => {})}
        tree={tree}
      />
    );

    const draggedProject = screen.getByText('Corso Mobile').closest('[draggable="true"]');
    expect(draggedProject).toBeTruthy();

    fireEvent.dragStart(draggedProject as HTMLElement);
    fireEvent.dragOver(container.firstElementChild as HTMLElement);
    fireEvent.drop(container.firstElementChild as HTMLElement);

    expect(onMoveProjects).toHaveBeenCalledWith(['project-1'], null, 1);
  });

  test('shows real folder save progress and confirms the completed mutation', async () => {
    const user = (await import('@testing-library/user-event')).default.setup();
    let finishCreate: (() => void) | undefined;
    const onCreateFolder = vi.fn(
      () =>
        new Promise<void>(resolve => {
          finishCreate = resolve;
        })
    );

    render(
      <LibraryTreeView
        createRootTrigger={1}
        openingProjectId={null}
        onCreateFolder={onCreateFolder}
        onConfirmDeleteFolder={vi.fn(async () => true)}
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

    await user.type(await screen.findByPlaceholderText('Nome cartella...'), 'Sistemi');
    await user.click(screen.getByRole('button', { name: 'Salva' }));

    expect(screen.getByRole('button', { name: 'Salvataggio in corso...' })).toHaveAttribute(
      'aria-busy',
      'true'
    );
    expect(onCreateFolder).toHaveBeenCalledWith({ name: 'Sistemi', parentFolderId: null });

    await act(async () => finishCreate?.());

    expect(await screen.findByRole('status')).toHaveTextContent('Cartella creata.');
  });

  test('closes the folder menu with Escape and restores focus to its trigger', async () => {
    const user = (await import('@testing-library/user-event')).default.setup();
    render(
      <LibraryTreeView
        openingProjectId={null}
        onCreateFolder={vi.fn(async () => {})}
        onConfirmDeleteFolder={vi.fn(async () => true)}
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
    const trigger = screen.getByRole('button', { name: 'Azioni cartella Frontend' });

    await user.click(trigger);
    expect(screen.getByRole('button', { name: 'Rinomina' })).toBeInTheDocument();
    await user.keyboard('{Escape}');

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Rinomina' })).toBeNull());
    expect(trigger).toHaveFocus();
  });

  test('keeps a failed move retryable and confirms the successful retry', async () => {
    const user = (await import('@testing-library/user-event')).default.setup();
    const onMoveProjects = vi
      .fn()
      .mockRejectedValueOnce(new Error('move failed'))
      .mockResolvedValueOnce([]);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(
      <LibraryTreeView
        openingProjectId={null}
        onCreateFolder={vi.fn(async () => {})}
        onConfirmDeleteFolder={vi.fn(async () => true)}
        onDeleteFolder={vi.fn(async () => {})}
        onDeleteProject={vi.fn()}
        onExportProject={vi.fn()}
        onMoveFolder={vi.fn(async () => {})}
        onMoveProjects={onMoveProjects}
        onOpenProject={vi.fn()}
        onRenameFolder={vi.fn(async () => {})}
        tree={tree}
      />
    );

    await user.click(screen.getByRole('button', { name: 'Azioni corso Corso Mobile' }));
    await user.click(screen.getByRole('button', { name: 'Sposta' }));
    const rootDestination = screen.getByRole('button', { name: /Radice libreria/ });
    await user.click(rootDestination);

    expect(await screen.findByRole('alert')).toHaveTextContent('Operazione non riuscita. Riprova.');
    await user.click(rootDestination);

    expect(await screen.findByRole('status')).toHaveTextContent('Elemento spostato.');
    expect(onMoveProjects).toHaveBeenCalledTimes(2);
  });

  test('completes a mobile long-press move when the touch is released', async () => {
    vi.useFakeTimers();
    window.matchMedia = vi.fn().mockReturnValue({
      matches: true,
      media: '(max-width: 767px)',
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    });
    const onMoveProjects = vi.fn(async () => []);
    render(
      <LibraryTreeView
        openingProjectId={null}
        onCreateFolder={vi.fn(async () => {})}
        onConfirmDeleteFolder={vi.fn(async () => true)}
        onDeleteFolder={vi.fn(async () => {})}
        onDeleteProject={vi.fn()}
        onExportProject={vi.fn()}
        onMoveFolder={vi.fn(async () => {})}
        onMoveProjects={onMoveProjects}
        onOpenProject={vi.fn()}
        onRenameFolder={vi.fn(async () => {})}
        tree={desktopTree}
      />
    );
    const draggedProject = screen.getByText('Corso Desktop').closest('[data-drag-id]');
    const targetFolder = screen.getByText('Backend').closest('[data-drag-id]');
    expect(draggedProject).toBeTruthy();
    expect(targetFolder).toBeTruthy();
    Object.defineProperty(targetFolder as HTMLElement, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        bottom: 100,
        height: 100,
        left: 0,
        right: 320,
        top: 0,
        width: 320,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }),
    });
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: vi.fn(() => targetFolder),
    });

    fireEvent.touchStart(draggedProject as HTMLElement, {
      touches: [{ clientX: 10, clientY: 10 }],
    });
    act(() => vi.advanceTimersByTime(300));
    fireEvent.touchMove(document, { touches: [{ clientX: 50, clientY: 50 }] });
    fireEvent.touchEnd(document);
    await act(async () => Promise.resolve());

    expect(onMoveProjects).toHaveBeenCalledWith(['project-2'], 'folder-2', 0);
  });
});
