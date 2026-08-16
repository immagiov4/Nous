// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { NewHomeView } from '../../../components/newHome/NewHomeView.tsx';
import type { LibraryTree, ProjectSnapshot, SavedProjectMeta } from '../../../types.ts';

vi.mock('../../../services/projects/courseCover.ts', () => ({
  ensureProjectCover: vi.fn(async () => 'data:image/png;base64,cG5n'),
}));

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

const originalMatchMedia = globalThis.matchMedia;

const mockPhoneViewport = (isPhoneViewport: boolean) => {
  globalThis.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query === '(max-width: 639px)' ? isPhoneViewport : false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
};

describe('NewHomeView library interactions', () => {
  beforeEach(() => {
    globalThis.history.replaceState({}, '', '/');
    globalThis.localStorage.clear();
  });

  afterEach(() => {
    globalThis.matchMedia = originalMatchMedia;
  });

  test.each([
    { isPhoneViewport: true, visibleResumeCourseCount: 1 },
    { isPhoneViewport: false, visibleResumeCourseCount: 3 },
  ])('shows $visibleResumeCourseCount resume course(s) when phone viewport is $isPhoneViewport', ({
    isPhoneViewport,
    visibleResumeCourseCount,
  }) => {
    mockPhoneViewport(isPhoneViewport);
    const resumeProjects = [
      { ...project, id: 'recent-project', title: 'Corso più recente' },
      { ...project, id: 'older-project', title: 'Corso precedente' },
      { ...project, id: 'oldest-project', title: 'Corso meno recente' },
    ];

    const { container } = render(
      <NewHomeView
        chatProps={chatProps}
        isDarkMode={false}
        isExportingProject={false}
        isLibraryLoading={false}
        libraryFolders={[]}
        libraryTree={{
          descendantProjectIdsByFolderId: {},
          folderById: {},
          placementByProjectId: {},
          rootNodes: [],
        }}
        loadProjectCover={vi.fn(async () => null)}
        loadProjectSource={vi.fn(async () => null)}
        loadProjectsById={vi.fn(async () => [])}
        onCreateFolder={vi.fn(async () => {})}
        onExportProject={vi.fn(async () => {})}
        onOpenProject={vi.fn()}
        onToggleDarkMode={vi.fn()}
        openingProjectId={null}
        projects={resumeProjects}
        saveProjectCover={vi.fn(async () => {})}
      />
    );

    const resumeSection = within(container.querySelector('#recent') as HTMLElement);
    expect(resumeSection.getByText('Corso più recente')).toBeInTheDocument();
    if (visibleResumeCourseCount === 3) {
      expect(resumeSection.getByText('Corso precedente')).toBeInTheDocument();
      expect(resumeSection.getByText('Corso meno recente')).toBeInTheDocument();
    } else {
      expect(resumeSection.queryByText('Corso precedente')).not.toBeInTheDocument();
      expect(resumeSection.queryByText('Corso meno recente')).not.toBeInTheDocument();
    }
  });

  test('does not add a standalone theme control to the phone header', () => {
    mockPhoneViewport(true);
    const { container } = render(
      <NewHomeView
        chatProps={chatProps}
        isDarkMode={false}
        isExportingProject={false}
        isLibraryLoading={false}
        libraryFolders={[folder]}
        libraryTree={tree}
        loadProjectCover={vi.fn(async () => null)}
        loadProjectSource={vi.fn(async () => null)}
        loadProjectsById={vi.fn(async () => [])}
        onCreateFolder={vi.fn(async () => {})}
        onExportProject={vi.fn(async () => {})}
        onOpenProject={vi.fn()}
        onToggleDarkMode={vi.fn()}
        openingProjectId={null}
        projects={[project]}
        saveProjectCover={vi.fn(async () => {})}
      />
    );

    const mobileHeader = within(container.querySelector('header') as HTMLElement);
    expect(
      mobileHeader.queryByRole('button', {
        name: /Usa tema scuro|Use dark theme/,
      })
    ).not.toBeInTheDocument();
  });

  test('imports a single course from the library header', async () => {
    const user = userEvent.setup();
    const onImportProjectFile = vi.fn();
    render(
      <NewHomeView
        chatProps={chatProps}
        isDarkMode={false}
        isExportingProject={false}
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

  test('keeps the Favorites count reactive and localized for empty, singular, and plural states', () => {
    const renderView = (projects: SavedProjectMeta[]) => (
      <NewHomeView
        chatProps={chatProps}
        isDarkMode={false}
        isExportingProject={false}
        isLibraryLoading={false}
        libraryFolders={[]}
        libraryTree={{
          descendantProjectIdsByFolderId: {},
          folderById: {},
          placementByProjectId: {},
          rootNodes: [],
        }}
        loadProjectCover={vi.fn(async () => null)}
        loadProjectSource={vi.fn(async () => null)}
        loadProjectsById={vi.fn(async () => [])}
        onCreateFolder={vi.fn(async () => {})}
        onExportProject={vi.fn(async () => {})}
        onOpenProject={vi.fn()}
        onToggleDarkMode={vi.fn()}
        openingProjectId={null}
        projects={projects}
        saveProjectCover={vi.fn(async () => {})}
      />
    );

    const view = render(renderView([]));
    const favoritesChip = screen.getByRole('button', { name: /^(Preferiti|Favorites)$/ });
    expect(favoritesChip).toHaveAttribute('title', '0 corsi');

    view.rerender(renderView([{ ...project, isFavorite: true }]));
    expect(screen.getByRole('button', { name: /^(Preferiti|Favorites)$/ })).toHaveAttribute(
      'title',
      '1 corso'
    );

    view.rerender(
      renderView([
        { ...project, isFavorite: true },
        { ...project, id: 'project-2', isFavorite: true },
      ])
    );
    expect(screen.getByRole('button', { name: /^(Preferiti|Favorites)$/ })).toHaveAttribute(
      'title',
      '2 corsi'
    );
  });

  test('repositions an open course menu and restores focus on Escape', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <NewHomeView
        chatProps={chatProps}
        isDarkMode={false}
        isExportingProject={false}
        isLibraryLoading={false}
        libraryFolders={[]}
        libraryTree={{
          descendantProjectIdsByFolderId: {},
          folderById: {},
          placementByProjectId: {},
          rootNodes: [],
        }}
        loadProjectCover={vi.fn(async () => null)}
        loadProjectSource={vi.fn(async () => null)}
        loadProjectsById={vi.fn(async () => [])}
        onCreateFolder={vi.fn(async () => {})}
        onExportProject={vi.fn(async () => {})}
        onOpenProject={vi.fn()}
        onToggleDarkMode={vi.fn()}
        openingProjectId={null}
        projects={[project]}
        saveProjectCover={vi.fn(async () => {})}
      />
    );
    const trigger = within(container.querySelector('#courses') as HTMLElement).getByRole('button', {
      name: /Azioni per Corso Mobile|Actions for Corso Mobile/,
    });
    let bounds = { top: 100, bottom: 120, left: 700, right: 720 };
    vi.spyOn(trigger, 'getBoundingClientRect').mockImplementation(() => bounds as DOMRect);

    const visualViewport = new EventTarget() as VisualViewport;
    Object.assign(visualViewport, {
      height: 400,
      offsetLeft: 80,
      offsetTop: 40,
      width: 400,
    });
    const originalVisualViewport = window.visualViewport;
    Object.defineProperty(window, 'visualViewport', {
      configurable: true,
      value: visualViewport,
    });

    try {
      await user.click(trigger);
      const menu = screen.getByRole('button', { name: /^(Apri corso|Open course)$/ })
        .parentElement as HTMLElement;
      expect(menu).toHaveStyle({ left: '276px', top: '124px' });
      const exportButton = screen.getByRole('button', { name: /^(Esporta|Export)$/ });
      exportButton.focus();

      bounds = { top: 300, bottom: 320, left: 700, right: 720 };
      window.dispatchEvent(new Event('scroll'));
      await waitFor(() => expect(menu).toHaveStyle({ top: '84px' }));
      expect(exportButton).toHaveFocus();

      await user.keyboard('{Escape}');
      expect(
        screen.queryByRole('button', { name: /^(Apri corso|Open course)$/ })
      ).not.toBeInTheDocument();
      expect(trigger).toHaveFocus();
    } finally {
      Object.defineProperty(window, 'visualViewport', {
        configurable: true,
        value: originalVisualViewport,
      });
    }
  });

  test.each([
    { filterLabel: null, isPhoneViewport: false },
    { filterLabel: /^(Preferiti|Favorites)$/, isPhoneViewport: true },
    { filterLabel: /^Frontend/, isPhoneViewport: false },
  ])('keeps export visibly busy for $filterLabel on phone viewport $isPhoneViewport', async ({
    filterLabel,
    isPhoneViewport,
  }) => {
    mockPhoneViewport(isPhoneViewport);
    const user = userEvent.setup();
    let finishExport: (() => void) | undefined;
    const onExportProject = vi.fn(
      () =>
        new Promise<void>(resolve => {
          finishExport = resolve;
        })
    );
    const renderView = (isExportingProject: boolean) => (
      <NewHomeView
        chatProps={chatProps}
        isDarkMode={false}
        isExportingProject={isExportingProject}
        isLibraryLoading={false}
        libraryFolders={[folder]}
        libraryTree={tree}
        loadProjectCover={vi.fn(async () => null)}
        loadProjectSource={vi.fn(async () => null)}
        loadProjectsById={vi.fn(async () => [])}
        onCreateFolder={vi.fn(async () => {})}
        onExportProject={onExportProject}
        onOpenProject={vi.fn()}
        onToggleDarkMode={vi.fn()}
        openingProjectId={null}
        projects={[{ ...project, isFavorite: true }]}
        saveProjectCover={vi.fn(async () => {})}
      />
    );
    const view = render(renderView(false));

    if (filterLabel) {
      await user.click(screen.getByRole('button', { name: filterLabel }));
    }
    await user.click(
      screen.getByRole('button', { name: /Azioni per Corso Mobile|Actions for Corso Mobile/ })
    );
    await user.click(screen.getByRole('button', { name: /^(Esporta|Export)$/ }));

    expect(onExportProject).toHaveBeenCalledOnce();
    expect(onExportProject).toHaveBeenCalledWith(project.id);
    view.rerender(renderView(true));
    const busyExportButton = screen.getByRole('button', {
      name: /Esportazione\.\.\.|Exporting\.\.\./,
    });
    expect(busyExportButton).toBeDisabled();
    expect(busyExportButton).toHaveAttribute('aria-busy', 'true');

    await act(async () => {
      finishExport?.();
      await onExportProject.mock.results[0]?.value;
    });
    expect(
      screen.queryByRole('button', { name: /Esportazione\.\.\.|Exporting\.\.\./ })
    ).not.toBeInTheDocument();
  });

  test('keeps a newer course menu open when an earlier export finishes', async () => {
    const user = userEvent.setup();
    let finishExport: (() => void) | undefined;
    const onExportProject = vi.fn(
      () =>
        new Promise<void>(resolve => {
          finishExport = resolve;
        })
    );
    const nextProject = { ...project, id: 'project-2', title: 'Corso Successivo' };
    const renderView = (isExportingProject: boolean) => (
      <NewHomeView
        chatProps={chatProps}
        isDarkMode={false}
        isExportingProject={isExportingProject}
        isLibraryLoading={false}
        libraryFolders={[]}
        libraryTree={{
          descendantProjectIdsByFolderId: {},
          folderById: {},
          placementByProjectId: {},
          rootNodes: [],
        }}
        loadProjectCover={vi.fn(async () => null)}
        loadProjectSource={vi.fn(async () => null)}
        loadProjectsById={vi.fn(async () => [])}
        onCreateFolder={vi.fn(async () => {})}
        onExportProject={onExportProject}
        onOpenProject={vi.fn()}
        onToggleDarkMode={vi.fn()}
        openingProjectId={null}
        projects={[project, nextProject]}
        saveProjectCover={vi.fn(async () => {})}
      />
    );
    const view = render(renderView(false));

    await user.click(
      screen.getByRole('button', { name: /Azioni per Corso Mobile|Actions for Corso Mobile/ })
    );
    await user.click(screen.getByRole('button', { name: /^(Esporta|Export)$/ }));
    view.rerender(renderView(true));
    await user.click(
      screen.getByRole('button', { name: /Chiudi azioni corso|Close course actions/ })
    );
    await user.click(
      screen.getByRole('button', {
        name: /Azioni per Corso Successivo|Actions for Corso Successivo/,
      })
    );

    await act(async () => {
      finishExport?.();
      await onExportProject.mock.results[0]?.value;
    });

    expect(
      screen.getByRole('button', { name: /Chiudi azioni corso|Close course actions/ })
    ).toBeInTheDocument();
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
        isExportingProject={false}
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
        isExportingProject={false}
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
        isExportingProject={false}
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

  test('shows and opens the original ZIP for an existing codebase course', async () => {
    globalThis.history.replaceState({}, '', '/library');
    const user = userEvent.setup();
    const createObjectUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:archive');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const file = {
      data: 'UEs=',
      mimeType: 'application/zip',
      name: 'src.zip',
      sourceId: 'source-archive',
    };
    const archiveProject = { ...project, sourceKind: 'codebase' as const };
    const snapshot = {
      id: archiveProject.id,
      source: {
        file,
        index: { entries: [] },
        kind: 'archive',
        name: file.name,
      },
    } as unknown as ProjectSnapshot;

    render(
      <NewHomeView
        chatProps={chatProps}
        isDarkMode={false}
        isExportingProject={false}
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
        projects={[archiveProject]}
        saveProjectCover={vi.fn(async () => {})}
      />
    );

    const sourceFolder = await screen.findByRole('button', { name: /Corso Mobile/ });
    await user.click(sourceFolder);
    const archiveButton = screen.getByRole('button', { name: /src.zip/ });
    expect(archiveButton).toHaveTextContent(/Archivio|Archive/);

    await user.click(archiveButton);
    const downloadLink = await screen.findByRole('link', {
      name: /Scarica archivio originale|Download original archive/,
    });
    expect(downloadLink).toHaveAttribute('href', 'blob:archive');
    expect(downloadLink).toHaveAttribute('download', 'src.zip');
    expect(createObjectUrl).toHaveBeenCalled();
  });
});
