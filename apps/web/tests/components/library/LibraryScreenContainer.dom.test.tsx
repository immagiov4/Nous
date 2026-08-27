// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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
  }: {
    chatProps: {
      assessmentComplete: boolean;
      homeChatMode: string;
      pendingFileNames?: string[];
    };
    onPageChange: (page: 'home' | 'library') => void;
  }) => (
    <>
      <div data-testid="new-home-surface">
        {chatProps.homeChatMode}:{String(chatProps.assessmentComplete)}:
        {chatProps.pendingFileNames?.join(',')}
      </div>
      <button type="button" onClick={() => onPageChange('library')}>
        Apri libreria
      </button>
    </>
  ),
}));

const buildProps = () =>
  ({
    controller: {
      assessmentMessages: [],
      courseProposal: null,
      confirmPlanGeneration: vi.fn(async () => ({})),
      isLibraryLoading: false,
      learningPlan: null,
      openingProjectId: null,
      savedProjects: [],
      setLearningPlan: vi.fn(),
      startHomeChat: vi.fn(),
      submitAssessment: vi.fn(),
      workflowState: { assessment: { message: '', status: 'idle' } },
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
  test.each([
    '/percorso-sconosciuto',
    '/api/projects/covers/regenerate',
  ])('uses the current home for %s instead of the removed legacy library', pathname => {
    globalThis.history.replaceState({}, '', pathname);

    render(<LibraryScreenContainer {...buildProps()} />);

    expect(screen.getByTestId('new-home-surface')).toHaveTextContent('new-course:false');
  });

  test('switches from library query to new course after choosing a local source', () => {
    globalThis.history.replaceState({}, '', '/library');

    const { container } = render(<LibraryScreenContainer {...buildProps()} />);
    const fileInput = container.querySelector<HTMLInputElement>('#library-source-file');

    expect(screen.getByTestId('new-home-surface')).toHaveTextContent('library-query:false');
    expect(fileInput).not.toBeNull();
    if (!fileInput) {
      throw new Error('Expected the library source file input.');
    }

    fireEvent.change(fileInput, {
      target: { files: [new File(['source'], 'source.md', { type: 'text/markdown' })] },
    });

    expect(screen.getByTestId('new-home-surface')).toHaveTextContent('new-course:false:source.md');
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
});
