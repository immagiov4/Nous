// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import type { ChangeEvent } from 'react';
import { expect, test, vi } from 'vitest';
import { useWorkspaceFileActions } from '../../../hooks/workspace/useWorkspaceFileActions.ts';
import { ProjectStorageError } from '../../../services/projects/projectRepository.ts';
import * as sourceSelection from '../../../services/projects/sourceFileSelection.ts';

type HookArgs = Parameters<typeof useWorkspaceFileActions>[0];

const buildHookArgs = (overrides: Partial<HookArgs> = {}): HookArgs => ({
  confirmProjectDelete: vi.fn(async () => true),
  deleteProject: vi.fn(async () => {}),
  exportProject: vi.fn(async () => {}),
  handleSourceUpload: vi.fn(async () => ({})),
  importProjectFile: vi.fn(async () => ({})),
  notify: vi.fn(),
  savedProjects: [],
  ...overrides,
});

test('exposes export progress, coalesces duplicate clicks, and confirms browser delivery', async () => {
  let finishExport: (() => void) | undefined;
  const exportProject = vi.fn(
    () =>
      new Promise<void>(resolve => {
        finishExport = resolve;
      })
  );
  const notify = vi.fn();
  const { result } = renderHook(() =>
    useWorkspaceFileActions(buildHookArgs({ exportProject, notify }))
  );

  let exportPromise: Promise<void> | undefined;
  act(() => {
    exportPromise = result.current.handleExportProject('project-1');
  });
  expect(result.current.isExportingProject).toBe(true);

  await act(async () => {
    await result.current.handleExportProject('project-1');
  });
  expect(exportProject).toHaveBeenCalledTimes(1);

  await act(async () => {
    finishExport?.();
    await exportPromise;
  });
  expect(result.current.isExportingProject).toBe(false);
  expect(notify).toHaveBeenCalledWith('Corso esportato. Il download è iniziato.', 'success');
});

test('reports export failures and leaves the action available for retry', async () => {
  const notify = vi.fn();
  const exportProject = vi.fn().mockRejectedValueOnce(new Error('archive failed'));
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const { result } = renderHook(() =>
    useWorkspaceFileActions(buildHookArgs({ exportProject, notify }))
  );

  await act(async () => {
    await result.current.handleExportProject('project-1');
  });

  expect(result.current.isExportingProject).toBe(false);
  expect(notify).toHaveBeenCalledWith('Esportazione non riuscita. Riprova.');
});

test('exposes import progress while a course is being imported', async () => {
  let finishImport: (() => void) | undefined;
  const importProjectFile = vi.fn(
    () =>
      new Promise<{ errorMessage?: string }>(resolve => {
        finishImport = () => resolve({});
      })
  );
  const target = {
    files: [new File(['backup'], 'course.nous.zip', { type: 'application/zip' })],
    value: 'selected',
  };
  const { result } = renderHook(() =>
    useWorkspaceFileActions(buildHookArgs({ importProjectFile }))
  );

  let importPromise: Promise<void> | undefined;
  act(() => {
    importPromise = result.current.handlePlanUpload({
      target,
    } as unknown as ChangeEvent<HTMLInputElement>);
  });
  expect(result.current.isImportingProject).toBe(true);

  await act(async () => {
    finishImport?.();
    await importPromise;
  });

  expect(result.current.isImportingProject).toBe(false);
  expect(target.value).toBe('');
});

test('forwards every selected course source in one upload action', async () => {
  const handleSourceUpload = vi.fn(async () => ({}));
  const { result } = renderHook(() =>
    useWorkspaceFileActions(buildHookArgs({ handleSourceUpload }))
  );
  const files = [
    new File(['beta'], 'beta.pdf', { type: 'application/pdf' }),
    new File(['alpha'], 'alpha.md', { type: 'text/markdown' }),
  ];
  const target = { files, value: 'selected' };

  await act(async () => {
    await result.current.handleFileUpload({ target } as unknown as ChangeEvent<HTMLInputElement>);
  });

  expect(handleSourceUpload).toHaveBeenCalledWith(files, { mode: 'new-project' });
  expect(target.value).toBe('');
});

test('reports unusable sources while continuing the multifonte upload', async () => {
  const notify = vi.fn();
  const handleSourceUpload = vi.fn(async () => ({
    sourceWarnings: [
      { name: 'scansione.pdf', message: 'internal extraction detail' },
      { name: 'vuoto.pdf', message: 'another internal detail' },
    ],
  }));
  const { result } = renderHook(() =>
    useWorkspaceFileActions(buildHookArgs({ handleSourceUpload, notify }))
  );
  const target = {
    files: [new File(['source'], 'scansione.pdf', { type: 'application/pdf' })],
    value: 'selected',
  };

  await act(async () => {
    await result.current.handleFileUpload({ target } as unknown as ChangeEvent<HTMLInputElement>);
  });

  expect(notify).toHaveBeenCalledWith(
    'Alcune fonti non sono state usate: scansione.pdf, vuoto.pdf. Il corso continua con le altre.'
  );
  expect(notify.mock.calls.flat().join(' ')).not.toContain('internal extraction detail');
});

test('keeps the requested reattachment mode while overlapping ZIP inspections finish', async () => {
  const files = [new File(['zip'], 'notes.zip', { type: 'application/zip' })];
  let finishInspection!: (
    selection: Awaited<ReturnType<typeof sourceSelection.inspectSourceSelection>>
  ) => void;
  const inspection = vi
    .spyOn(sourceSelection, 'inspectSourceSelection')
    .mockImplementationOnce(
      () =>
        new Promise(resolve => {
          finishInspection = resolve;
        })
    )
    .mockResolvedValueOnce({ files: [], warnings: [] });
  const handleSourceUpload = vi.fn(async () => ({}));
  const { result } = renderHook(() =>
    useWorkspaceFileActions(buildHookArgs({ handleSourceUpload }))
  );
  const first = { files, value: 'first' };
  const second = { files: [new File(['oversized'], 'oversized.pdf')], value: 'second' };
  try {
    let firstUpload!: Promise<void>;
    act(() => {
      result.current.handleAttachSourceFile();
      firstUpload = result.current.handleFileUpload({
        target: first,
      } as unknown as ChangeEvent<HTMLInputElement>);
      result.current.handleAttachSourceFile();
    });
    await act(async () => {
      await result.current.handleFileUpload({
        target: second,
      } as unknown as ChangeEvent<HTMLInputElement>);
      finishInspection({ files, warnings: [] });
      await firstUpload;
    });
    expect(handleSourceUpload).toHaveBeenCalledExactlyOnceWith(files, { mode: 'reattach-source' });
  } finally {
    inspection.mockRestore();
  }
});

test('handles confirmed deletion failure with action-specific feedback', async () => {
  const diagnostic = vi.spyOn(console, 'error');
  const notify = vi.fn();
  const deleteProject = vi.fn().mockRejectedValue(new Error('private deletion detail'));
  const { result } = renderHook(() =>
    useWorkspaceFileActions(buildHookArgs({ deleteProject, notify }))
  );
  await act(async () => {
    await expect(result.current.handleDeleteProject('project-1')).resolves.toBeUndefined();
  });
  expect(deleteProject).toHaveBeenCalledWith('project-1');
  expect(notify).toHaveBeenCalledExactlyOnceWith(
    'Eliminazione del corso non confermata. Ricarica la pagina.'
  );
  expect(diagnostic).toHaveBeenCalledWith(
    '[Nous][Delete] Course deletion could not be confirmed.',
    { errorType: 'Error', code: 'unknown', httpStatus: undefined }
  );
});

test('reports uncertainty when a delete succeeds but refreshing the library fails', async () => {
  const persistedProjectIds = new Set(['project-1']);
  const refreshLibrary = vi.fn().mockRejectedValue(new Error('list folders failed'));
  const deleteProject = vi.fn(async (projectId: string) => {
    persistedProjectIds.delete(projectId);
    await refreshLibrary();
  });
  const notify = vi.fn();
  const { result } = renderHook(() =>
    useWorkspaceFileActions(buildHookArgs({ deleteProject, notify }))
  );
  await act(async () => {
    await expect(result.current.handleDeleteProject('project-1')).resolves.toBeUndefined();
  });
  expect(persistedProjectIds.has('project-1')).toBe(false);
  expect(deleteProject).toHaveBeenCalledTimes(1);
  expect(refreshLibrary).toHaveBeenCalledTimes(1);
  expect(notify).toHaveBeenCalledExactlyOnceWith(
    'Eliminazione del corso non confermata. Ricarica la pagina.'
  );
});

test('records sanitized storage diagnostics before notifying about uncertain deletion', async () => {
  const failure = new ProjectStorageError('private user content and token', 'persistence-failed', {
    status: 503,
  });
  const deleteProject = vi.fn().mockRejectedValue(failure);
  const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {});
  const notify = vi.fn();
  const { result } = renderHook(() =>
    useWorkspaceFileActions(buildHookArgs({ deleteProject, notify }))
  );
  await act(async () => {
    await result.current.handleDeleteProject('project-1');
  });
  expect(diagnostic).toHaveBeenCalledExactlyOnceWith(
    '[Nous][Delete] Course deletion could not be confirmed.',
    {
      errorType: 'ProjectStorageError',
      code: 'persistence-failed',
      httpStatus: 503,
    }
  );
  expect(diagnostic.mock.invocationCallOrder[0]).toBeLessThan(notify.mock.invocationCallOrder[0]);
  expect(notify).toHaveBeenCalledExactlyOnceWith(
    'Eliminazione del corso non confermata. Ricarica la pagina.'
  );
});
