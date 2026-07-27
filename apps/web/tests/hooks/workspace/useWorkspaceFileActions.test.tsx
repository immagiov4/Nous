// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import type { ChangeEvent } from 'react';
import { expect, test, vi } from 'vitest';
import { useWorkspaceFileActions } from '../../../hooks/workspace/useWorkspaceFileActions.ts';

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
