// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { NewHomeView } from '../../../components/newHome/NewHomeView.tsx';
import type { LibraryTree, ProjectSnapshot, SavedProjectMeta } from '../../../types.ts';

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

const folder = {
  id: 'folder-1',
  name: 'Frontend',
  parentFolderId: null,
  createdAt: '2026-04-04T10:00:00.000Z',
  updatedAt: '2026-04-04T10:00:00.000Z',
  order: 1,
};

const tree: LibraryTree = {
  descendantProjectIdsByFolderId: { 'folder-1': ['project-1'] },
  folderById: { 'folder-1': folder },
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
      folder,
      descendantProjectIds: ['project-1'],
      children: [{ id: 'project-1', kind: 'project', order: 1, project }],
    },
  ],
};

const chatProps = {
  assessmentComplete: false,
  assessmentMessages: [],
  homeChatMode: 'library-query' as const,
  isDarkMode: false,
  isLibraryLoading: false,
  isLibraryModeLoading: false,
  isNewCourseLoading: false,
  libraryAttachedContextRefs: [],
  libraryErrorMessage: null,
  libraryGenerateArtifacts: false,
  libraryMessages: [],
  libraryTree: tree,
  libraryWebSearch: false,
  newCourseLoadingStatus: '',
  onClearPendingFile: vi.fn(),
  onConfirmGenerate: vi.fn(),
  onHomeChatModeChange: vi.fn(),
  onLibraryGenerateArtifactsChange: vi.fn(),
  onLibraryMessageSend: vi.fn(async () => {}),
  onLibraryWebSearchChange: vi.fn(),
  onSendAssessmentMessage: vi.fn(async () => {}),
  onToggleLibraryContextRef: vi.fn(),
  onUploadSourceClick: vi.fn(),
  pendingFileName: null,
};

describe('NewHomeView library rename', () => {
  beforeEach(() => {
    globalThis.history.replaceState({}, '', '/');
    globalThis.localStorage.clear();
  });

  test('imports a single course from the library header', async () => {
    const user = userEvent.setup();
    const onImportProjectFile = vi.fn();
    render(
      <NewHomeView
        chatProps={chatProps}
        isDarkMode={false}
        isLibraryLoading={false}
        libraryFolders={[folder]}
        libraryTree={tree}
        loadProjectCover={vi.fn(async () => null)}
        loadProjectSource={vi.fn(async () => null)}
        loadProjectsById={vi.fn(async () => [])}
        onCreateFolder={vi.fn(async () => {})}
        onImportProjectFile={onImportProjectFile}
        onOpenProject={vi.fn()}
        onToggleDarkMode={vi.fn()}
        openingProjectId={null}
        projects={[project]}
        saveProjectCover={vi.fn(async () => {})}
      />
    );

    const file = new File(['backup'], 'course.nous.zip', { type: 'application/zip' });
    await user.upload(screen.getByLabelText(/^Importa$|^Import$/), file);

    expect(onImportProjectFile).toHaveBeenCalledTimes(1);
    expect(onImportProjectFile.mock.calls[0]?.[0].target.files?.[0]).toBe(file);
  });

  test('renames course and folder names inline on double click', async () => {
    const user = userEvent.setup();
    const onOpenProject = vi.fn();
    const onRenameProject = vi.fn(async () => {});
    const onRenameFolder = vi.fn(async () => {});
    const { container } = render(
      <NewHomeView
        chatProps={chatProps}
        isDarkMode={false}
        isLibraryLoading={false}
        libraryFolders={[folder]}
        libraryTree={tree}
        loadProjectCover={vi.fn(async () => null)}
        loadProjectSource={vi.fn(async () => null)}
        loadProjectsById={vi.fn(async () => [])}
        onCreateFolder={vi.fn(async () => {})}
        onOpenProject={onOpenProject}
        onRenameFolder={onRenameFolder}
        onRenameProject={onRenameProject}
        onToggleDarkMode={vi.fn()}
        openingProjectId={null}
        projects={[project]}
        saveProjectCover={vi.fn(async () => {})}
      />
    );
    const courses = container.querySelector('#courses');
    expect(courses).toBeTruthy();
    const courseList = within(courses as HTMLElement);

    await user.click(
      courseList.getByRole('button', { name: /Azioni per Corso Mobile|Actions for Corso Mobile/ })
    );
    await user.click(screen.getByRole('button', { name: /^(Rinomina|Rename)$/ }));
    expect(screen.getByRole('textbox', { name: /Rinomina corso|Rename course/ })).toHaveFocus();
    await user.keyboard('{Escape}');

    await user.dblClick(courseList.getByRole('button', { name: project.title }));
    const courseInput = screen.getByRole('textbox', { name: /Rinomina corso|Rename course/ });
    await user.clear(courseInput);
    await user.type(courseInput, 'Corso rinominato{Enter}');

    expect(onRenameProject).toHaveBeenCalledWith('project-1', 'Corso rinominato');
    expect(onOpenProject).not.toHaveBeenCalled();

    await user.click(courseList.getByRole('button', { name: project.title }));
    expect(onOpenProject).not.toHaveBeenCalled();

    await user.click(courseList.getByRole('button', { name: /3 lezioni/ }));
    expect(onOpenProject).toHaveBeenCalledWith('project-1');

    await user.dblClick(courseList.getByRole('heading', { name: folder.name }));
    const folderInput = screen.getByRole('textbox', {
      name: /Rinomina cartella|Rename folder/,
    });
    await user.clear(folderInput);
    await user.type(folderInput, 'Interfacce{Enter}');

    expect(onRenameFolder).toHaveBeenCalledWith('folder-1', 'Interfacce');
  });

  test('ignores an obsolete rename result after the user starts editing another target', async () => {
    const user = userEvent.setup();
    let finishProjectRename: (() => void) | undefined;
    const onRenameProject = vi.fn(
      () =>
        new Promise<void>(resolve => {
          finishProjectRename = resolve;
        })
    );
    const { container } = render(
      <NewHomeView
        chatProps={chatProps}
        isDarkMode={false}
        isLibraryLoading={false}
        libraryFolders={[folder]}
        libraryTree={tree}
        loadProjectCover={vi.fn(async () => null)}
        loadProjectSource={vi.fn(async () => null)}
        loadProjectsById={vi.fn(async () => [])}
        onCreateFolder={vi.fn(async () => {})}
        onOpenProject={vi.fn()}
        onRenameFolder={vi.fn(async () => {})}
        onRenameProject={onRenameProject}
        onToggleDarkMode={vi.fn()}
        openingProjectId={null}
        projects={[project]}
        saveProjectCover={vi.fn(async () => {})}
      />
    );
    const courses = within(container.querySelector('#courses') as HTMLElement);

    await user.dblClick(courses.getByRole('button', { name: project.title }));
    const projectInput = screen.getByRole('textbox', {
      name: /Rinomina corso|Rename course/,
    });
    await user.clear(projectInput);
    await user.type(projectInput, 'Rinomina in corso{Enter}');
    expect(onRenameProject).toHaveBeenCalledTimes(1);

    await user.keyboard('{Escape}');
    await user.dblClick(courses.getByRole('heading', { name: folder.name }));
    expect(screen.getByRole('textbox', { name: /Rinomina cartella|Rename folder/ })).toHaveFocus();

    await act(async () => finishProjectRename?.());

    expect(
      screen.getByRole('textbox', { name: /Rinomina cartella|Rename folder/ })
    ).toBeInTheDocument();
  });

  test('groups course sources in a collapsed folder', async () => {
    globalThis.history.replaceState({}, '', '/library');
    const user = userEvent.setup();
    const file = {
      data: 'ZmlsZQ==',
      mimeType: 'application/pdf',
      name: 'dispensa.pdf',
      sourceId: 'source-1',
    };
    const snapshot = {
      id: project.id,
      source: {
        file,
        kind: 'pdf',
        sources: [
          {
            file,
            hash: 'hash-source-1',
            id: 'source-1',
            kind: 'pdf',
            name: file.name,
            outline: [],
            outlineOrigin: 'none',
            position: 0,
            status: 'ready',
          },
        ],
      },
    } as unknown as ProjectSnapshot;

    render(
      <NewHomeView
        chatProps={chatProps}
        isDarkMode={false}
        isLibraryLoading={false}
        libraryFolders={[folder]}
        libraryTree={tree}
        loadProjectCover={vi.fn(async () => null)}
        loadProjectSource={vi.fn(async () => file)}
        loadProjectsById={vi.fn(async () => [snapshot])}
        onCreateFolder={vi.fn(async () => {})}
        onOpenProject={vi.fn()}
        onToggleDarkMode={vi.fn()}
        openingProjectId={null}
        projects={[project]}
        saveProjectCover={vi.fn(async () => {})}
      />
    );

    const sourceFolder = await screen.findByRole('button', { name: /Corso Mobile/ });
    expect(sourceFolder).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('button', { name: /dispensa.pdf/ })).toBeNull();

    await user.click(sourceFolder);
    expect(sourceFolder).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: /dispensa.pdf/ })).toBeInTheDocument();
  });
});
