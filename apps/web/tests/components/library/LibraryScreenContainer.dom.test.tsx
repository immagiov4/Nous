import CourseSetupHeader from '../../../components/library/CourseSetupHeader.tsx';
import * as sourceSelection from '../../../services/projects/sourceFileSelection.ts';
// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { LibraryScreenContainer } from '../../../components/library/LibraryScreenContainer.tsx';
import {
  clearFeedbackDiagnostics,
  getFeedbackDiagnosticsSnapshot,
  recordFeedbackWorkflowSnapshot,
  setFeedbackProductContext,
} from '../../../services/feedback/browserDiagnostics.ts';

vi.mock('../../../components/newHome/NewHomeView.tsx', () => ({
  NewHomeView: ({
    chatProps,
    onPageChange,
    storageError,
  }: {
    chatProps: {
      assessmentComplete: boolean;
      assessmentMessages: { text: string }[];
      onConfirmGenerate: () => Promise<void>;
      homeChatMode: string;
      onCancelNewCourse: () => Promise<boolean>;
      onHomeChatModeChange: (mode: 'library-query' | 'new-course') => void;
      onSendAssessmentMessage: (message: string) => Promise<void>;
      pendingFileNames?: string[];
      sourceCount?: number;
      pendingFileWarnings?: string[];
    };
    onPageChange: (page: 'home' | 'library') => void;
    storageError?: string | null;
  }) => (
    <>
      {storageError ? <div role="alert">{storageError}</div> : null}
      <div data-testid="new-home-surface">
        {chatProps.homeChatMode}:{String(chatProps.assessmentComplete)}:
        {chatProps.pendingFileNames?.join(',')}
        {chatProps.pendingFileWarnings?.join(',')}
      </div>
      <div data-testid="confirmation-messages">
        {chatProps.assessmentMessages.map(message => message.text).join('\n')}
      </div>
      <CourseSetupHeader
        phase="sources"
        sourceCount={chatProps.sourceCount ?? 0}
        hasPreferences={false}
        hasDiagnostic={false}
        isLoading={false}
      />
      <button type="button" onClick={() => void chatProps.onConfirmGenerate()}>
        Conferma scelte
      </button>
      <button type="button" onClick={() => onPageChange('library')}>
        Apri libreria
      </button>
      <button type="button" onClick={() => chatProps.onHomeChatModeChange('library-query')}>
        Scorciatoia libreria
      </button>
      <button type="button" onClick={() => void chatProps.onSendAssessmentMessage('Nuovo corso')}>
        Invia nuovo corso
      </button>
      <button type="button" onClick={() => void chatProps.onCancelNewCourse()}>
        Ferma nuovo corso
      </button>
    </>
  ),
}));

const buildProps = () =>
  ({
    controller: {
      assessmentMessages: [],
      cancelAssessment: vi.fn(async () => {}),
      courseProposal: null,
      confirmPlanGeneration: vi.fn(async () => ({})),
      isLibraryLoading: false,
      learningPlan: null,
      openingProjectId: null,
      savedProjects: [],
      setLearningPlan: vi.fn(),
      startHomeChat: vi.fn(),
      submitAssessment: vi.fn(),
      workflowState: {
        assessment: { message: '', status: 'idle' },
        generatePlan: { status: 'idle' },
      },
    },
    fileActions: {
      isExportingProject: false,
      sourceFileInputId: 'library-source-file',
    },
    libraryAssistantChat: {
      error: null,
    },
    navigation: {},
    notify: vi.fn(),
    projectLibrary: {
      getCurrentProjectId: vi.fn(() => null),
      libraryFolders: [],
      libraryTree: {},
      renameProject: vi.fn(),
    },
    readerState: {
      readerChrome: {
        isDarkMode: false,
        setIsDarkMode: vi.fn(),
      },
    },
    requestConfirmation: vi.fn(async () => true),
  }) as unknown as ComponentProps<typeof LibraryScreenContainer>;

afterEach(() => {
  cleanup();
  clearFeedbackDiagnostics();
  globalThis.history.replaceState({}, '', '/');
});

describe('LibraryScreenContainer route fallback', () => {
  test('counts expanded preparation documents in the setup header', () => {
    const props = buildProps();
    props.controller.workflowState.assessment = {
      status: 'pending',
      requestId: 1,
      sourcePreparation: {
        step: 'extraction',
        completed: 1,
        total: 3,
        documents: [
          { id: 'one', name: 'one.md', state: 'done' },
          { id: 'two', name: 'two.md', state: 'reading' },
          { id: 'three', name: 'three.md', state: 'idle' },
        ],
      },
    };
    render(<LibraryScreenContainer {...props} />);
    expect(screen.getByText('3 fonti')).toBeVisible();
  });

  test('keeps the terminal preparation error and source warnings in one notification', async () => {
    const props = buildProps();
    props.controller.startHomeChat = vi.fn().mockResolvedValue({
      outcome: 'failed',
      errorMessage: 'Preparation failed. Retry.',
      sourceWarnings: [{ name: 'bad.pdf', message: 'Unreadable source' }],
    });
    render(<LibraryScreenContainer {...props} />);
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Invia nuovo corso' }))
    );
    expect(props.notify).toHaveBeenCalledOnce();
    expect(props.notify).toHaveBeenCalledWith(
      expect.stringContaining('Preparation failed. Retry.')
    );
    expect(props.notify).toHaveBeenCalledWith(expect.stringContaining('bad.pdf'));
  });
  test('passes storage warnings to the library destination and clears recovered warnings', () => {
    const props = buildProps();
    props.projectLibrary.storageError =
      'I corsi sono stati importati. Ricarica la libreria per visualizzarli.';
    const view = render(<LibraryScreenContainer {...props} />);
    expect(screen.getByRole('alert')).toHaveTextContent(props.projectLibrary.storageError);
    props.projectLibrary.storageError = null;
    view.rerender(<LibraryScreenContainer {...props} />);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
  test('sends one approval while a confirmation is pending', async () => {
    let complete!: () => void;
    const pending = new Promise<void>(resolve => {
      complete = resolve;
    });
    const props = buildProps();
    props.controller.confirmPlanGeneration = vi.fn(async () => {
      await pending;
      return { outcome: 'diagnostic' as const };
    });
    render(<LibraryScreenContainer {...props} />);
    const confirm = screen.getByRole('button', { name: 'Conferma scelte' });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(props.controller.confirmPlanGeneration).toHaveBeenCalledTimes(1);
    await act(async () => complete());
  });
  test('clears the confirmation when approval fails', async () => {
    const props = buildProps();
    props.controller.currentProjectId = 'first-course';
    props.controller.supportsCoursePreferences = true;
    props.controller.confirmPlanGeneration = vi.fn(async () => ({
      outcome: 'failed' as const,
      errorMessage: 'Riprova',
    }));
    render(<LibraryScreenContainer {...props} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Conferma scelte' }));
    });
    expect(screen.getByTestId('confirmation-messages')).toBeEmptyDOMElement();
    expect(props.notify).toHaveBeenCalledWith('Riprova');
  });
  test('keeps confirmed choices with their course while approval is pending', async () => {
    const props = buildProps();
    props.controller.currentProjectId = 'first-course';
    props.controller.supportsCoursePreferences = true;
    const { rerender } = render(<LibraryScreenContainer {...props} />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Conferma scelte' }));
    });
    expect(props.controller.confirmPlanGeneration).toHaveBeenCalledWith({
      coursePlanningControls: { depth: 'auto', granularity: 'auto' },
    });
    expect(screen.getByTestId('confirmation-messages')).toHaveTextContent(
      'Approfondimento: Auto. Granularità: Auto.'
    );
    props.controller.currentProjectId = 'second-course';
    rerender(<LibraryScreenContainer {...props} />);
    expect(screen.getByTestId('confirmation-messages')).toBeEmptyDOMElement();
  });
  test.each([
    '/percorso-sconosciuto',
    '/api/projects/covers/regenerate',
  ])('uses the current home for %s instead of the removed legacy library', pathname => {
    globalThis.history.replaceState({}, '', pathname);

    render(<LibraryScreenContainer {...buildProps()} />);

    expect(screen.getByTestId('new-home-surface')).toHaveTextContent('new-course:false');
  });

  test('switches from library query to new course after choosing a local source', async () => {
    globalThis.history.replaceState({}, '', '/library');

    const { container } = render(<LibraryScreenContainer {...buildProps()} />);
    const fileInput = container.querySelector<HTMLInputElement>('#library-source-file');

    expect(screen.getByTestId('new-home-surface')).toHaveTextContent('library-query:false');
    expect(fileInput).not.toBeNull();
    if (!fileInput) {
      throw new Error('Expected the library source file input.');
    }

    await act(async () => {
      fireEvent.change(fileInput, {
        target: { files: [new File(['source'], 'source.md', { type: 'text/markdown' })] },
      });
    });

    expect(screen.getByTestId('new-home-surface')).toHaveTextContent('new-course:false:source.md');
  });

  test('shows pending file count instead of the previous course source count', async () => {
    const props = buildProps();
    props.controller.source = {
      kind: 'document',
      file: { name: 'old.md', mimeType: 'text/markdown', data: '' },
    };
    const { container } = render(<LibraryScreenContainer {...props} />);
    expect(screen.getByText('1 fonte')).toBeVisible();
    const input = container.querySelector<HTMLInputElement>('#library-source-file');
    if (!input) throw new Error('Missing source input');
    await act(async () =>
      fireEvent.change(input, {
        target: {
          files: [
            new File(['first'], 'first.md', { type: 'text/markdown' }),
            new File(['second'], 'second.md', { type: 'text/markdown' }),
          ],
        },
      })
    );
    expect(screen.getByText('2 fonti')).toBeVisible();
    await act(async () => fireEvent.change(input, { target: { files: [] } }));
    expect(screen.getByText('1 fonte')).toBeVisible();
  });

  test('retains the latest selection when an earlier archive inspection finishes later', async () => {
    const first = new File(['first'], 'first.zip', { type: 'application/zip' });
    const second = new File(['second'], 'second.md', { type: 'text/markdown' });
    let finishFirst!: (value: { files: File[]; warnings: [] }) => void;
    const inspection = vi
      .spyOn(sourceSelection, 'inspectSourceSelection')
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            finishFirst = resolve;
          })
      )
      .mockResolvedValueOnce({ files: [second], warnings: [] });
    try {
      const { container } = render(<LibraryScreenContainer {...buildProps()} />);
      const input = container.querySelector<HTMLInputElement>('#library-source-file');
      if (!input) throw new Error('Missing source input');
      fireEvent.change(input, { target: { files: [first] } });
      await act(async () => {
        fireEvent.change(input, { target: { files: [second] } });
      });
      expect(screen.getByTestId('new-home-surface')).toHaveTextContent('second.md');
      await act(async () => {
        finishFirst({ files: [first], warnings: [] });
      });
      expect(screen.getByTestId('new-home-surface')).toHaveTextContent('second.md');
    } finally {
      inspection.mockRestore();
    }
  });

  test.each([
    'continued',
    'abandoned',
  ] as const)('clears exclusion notices when the source selection is %s', async outcome => {
    const file = new File(['valid'], 'valid.md', { type: 'text/markdown' });
    const inspection = vi.spyOn(sourceSelection, 'inspectSourceSelection').mockResolvedValue({
      files: [file],
      warnings: [{ name: 'excluded.pdf', message: 'Too large' }],
    });
    const props = buildProps();
    props.controller.startHomeChat = vi.fn().mockResolvedValue({ outcome });
    try {
      const { container } = render(<LibraryScreenContainer {...props} />);
      const input = container.querySelector<HTMLInputElement>('#library-source-file');
      if (!input) throw new Error('Missing source input');
      await act(async () => fireEvent.change(input, { target: { files: [file] } }));
      expect(screen.getByTestId('new-home-surface')).toHaveTextContent('excluded.pdf');
      await act(async () =>
        fireEvent.click(screen.getByRole('button', { name: 'Invia nuovo corso' }))
      );
      expect(screen.getByTestId('new-home-surface')).not.toHaveTextContent('excluded.pdf');
    } finally {
      inspection.mockRestore();
    }
  });

  test('keeps a cancelled selection cleared when its inspection finishes later', async () => {
    const file = new File(['archive'], 'abandoned.zip', { type: 'application/zip' });
    let finish!: (
      result: Awaited<ReturnType<typeof sourceSelection.inspectSourceSelection>>
    ) => void;
    const inspection = vi.spyOn(sourceSelection, 'inspectSourceSelection').mockImplementation(
      () =>
        new Promise(resolve => {
          finish = resolve;
        })
    );
    const props = buildProps();
    props.controller.assessmentMessages = [{ role: 'model', text: 'Existing interview' }];
    try {
      const { container } = render(<LibraryScreenContainer {...props} />);
      const input = container.querySelector<HTMLInputElement>('#library-source-file');
      if (!input) throw new Error('Missing source input');
      fireEvent.change(input, { target: { files: [file] } });
      await act(async () =>
        fireEvent.click(screen.getByRole('button', { name: 'Ferma nuovo corso' }))
      );
      await act(async () =>
        finish({ files: [file], warnings: [{ name: 'excluded.pdf', message: 'Too large' }] })
      );
      expect(screen.getByTestId('new-home-surface')).not.toHaveTextContent('abandoned.zip');
      expect(screen.getByTestId('new-home-surface')).not.toHaveTextContent('excluded.pdf');
    } finally {
      inspection.mockRestore();
    }
  });

  test('restores an unfinished interview in the home chat without the legacy assessment screen', () => {
    globalThis.history.replaceState({}, '', '/library');
    const props = buildProps();
    props.controller.assessmentMessages = [{ role: 'model', text: 'Proposta pronta' }];
    props.controller.courseProposal = {
      context: 'Studio individuale',
      experienceLevel: 'Base',
      goals: 'Capire il tema',
      language: 'Italiano',
      learningStyle: 'Progressivo',
      topic: 'Sistemi distribuiti',
    };

    render(<LibraryScreenContainer {...props} />);

    expect(screen.getByTestId('new-home-surface')).toHaveTextContent('new-course:true');
  });

  test('ignores external chat mode shortcuts while a library response is active', () => {
    globalThis.history.replaceState({}, '', '/percorso-sconosciuto');
    const props = buildProps();
    props.libraryAssistantChat.isLoading = true;

    render(<LibraryScreenContainer {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Scorciatoia libreria' }));

    expect(screen.getByTestId('new-home-surface')).toHaveTextContent('new-course:false');
  });

  test('routes an external assessment to new-course before its first message arrives', () => {
    globalThis.history.replaceState({}, '', '/library');
    const props = buildProps();
    props.controller.workflowState.assessment.status = 'pending';

    render(<LibraryScreenContainer {...props} />);

    expect(screen.getByTestId('new-home-surface')).toHaveTextContent('new-course:false');
  });

  test('ignores source uploads while a library response is streaming', async () => {
    globalThis.history.replaceState({}, '', '/library');
    const props = buildProps();
    props.libraryAssistantChat.isLoading = true;

    const { container } = render(<LibraryScreenContainer {...props} />);
    const fileInput = container.querySelector<HTMLInputElement>('#library-source-file');
    expect(fileInput).not.toBeNull();
    if (!fileInput) {
      throw new Error('Expected the library source file input.');
    }

    await act(async () => {
      fireEvent.change(fileInput, {
        target: { files: [new File(['source'], 'source.md', { type: 'text/markdown' })] },
      });
    });

    expect(screen.getByTestId('new-home-surface')).toHaveTextContent('library-query:false:');
  });

  test('ignores a canceled course result after a newer source is selected', async () => {
    let resolveCanceledStart: (result: { outcome: 'abandoned' }) => void = () => {};
    const canceledStart = new Promise<{ outcome: 'abandoned' }>(resolve => {
      resolveCanceledStart = resolve;
    });
    const props = buildProps();
    props.controller.startHomeChat = vi.fn(() => canceledStart) as never;

    const { container } = render(<LibraryScreenContainer {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Invia nuovo corso' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ferma nuovo corso' }));
    await act(async () => {});

    const fileInput = container.querySelector<HTMLInputElement>('#library-source-file');
    if (!fileInput) throw new Error('Expected the library source file input.');
    fireEvent.change(fileInput, {
      target: { files: [new File(['new source'], 'new-source.md', { type: 'text/markdown' })] },
    });

    await act(async () => {
      resolveCanceledStart({ outcome: 'abandoned' });
      await canceledStart;
    });

    expect(screen.getByTestId('new-home-surface')).toHaveTextContent(
      'new-course:false:new-source.md'
    );
  });

  test('reports cancellation failures without exposing the technical error', async () => {
    const props = buildProps();
    props.controller.cancelAssessment = vi.fn(async () => {
      throw new Error('sentinel storage secret');
    });

    render(<LibraryScreenContainer {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Ferma nuovo corso' }));
    await act(async () => {});

    expect(props.notify).toHaveBeenCalledWith(
      expect.stringMatching(
        /^(Operation failed\. Try again\.|Operazione non riuscita\. Riprova\.)$/
      )
    );
    expect(props.notify).not.toHaveBeenCalledWith(expect.stringContaining('sentinel'));
  });

  test('preserves retained project, section, and workflow context across home page changes', () => {
    setFeedbackProductContext({
      project: { id: 'project-12345678', revision: 7 },
      section: { id: 'section-12345678' },
      surface: 'reader',
    });
    recordFeedbackWorkflowSnapshot({
      operation: 'load-section',
      projectId: 'project-12345678',
      runId: '123e4567-e89b-42d3-a456-426614174000',
      sectionId: 'section-12345678',
      status: 'completed',
    });
    const props = buildProps();
    props.controller.activeSection = { id: 'section-12345678' } as never;
    props.controller.currentProjectId = 'project-12345678';
    props.controller.savedProjects = [{ id: 'project-12345678', revision: 7 }] as never;

    render(<LibraryScreenContainer {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Apri libreria' }));

    expect(getFeedbackDiagnosticsSnapshot().productContext).toMatchObject({
      project: { id: 'project-12345678', revision: 7 },
      section: { id: 'section-12345678' },
      surface: 'library',
      workflow: {
        operation: 'load-section',
        runId: '123e4567-e89b-42d3-a456-426614174000',
        status: 'completed',
      },
    });
  });

  test('preserves the assessment surface while the interview remains active', () => {
    const props = buildProps();
    props.controller.assessmentMessages = [{ role: 'model', text: 'Prima domanda' }] as never;

    render(<LibraryScreenContainer {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Apri libreria' }));

    expect(getFeedbackDiagnosticsSnapshot().productContext?.surface).toBe('assessment');
  });
});
