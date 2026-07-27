// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { LibraryScreenContainer } from '../../../components/library/LibraryScreenContainer.tsx';

vi.mock('../../../components/newHome/NewHomeView.tsx', () => ({
  NewHomeView: ({
    chatProps,
  }: {
    chatProps: { homeChatMode: string; pendingFileNames?: string[] };
  }) => (
    <div data-testid="new-home-surface">
      {chatProps.homeChatMode}:{chatProps.pendingFileNames?.join(',')}
    </div>
  ),
}));

const buildProps = () =>
  ({
    controller: {
      assessmentMessages: [],
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
  globalThis.history.replaceState({}, '', '/');
});

describe('LibraryScreenContainer route fallback', () => {
  test.each([
    '/percorso-sconosciuto',
    '/api/projects/covers/regenerate',
  ])('uses the current home for %s instead of the removed legacy library', pathname => {
    globalThis.history.replaceState({}, '', pathname);

    render(<LibraryScreenContainer {...buildProps()} />);

    expect(screen.getByTestId('new-home-surface')).toHaveTextContent('new-course');
  });

  test('switches from library query to new course after choosing a local source', () => {
    globalThis.history.replaceState({}, '', '/library');

    const { container } = render(<LibraryScreenContainer {...buildProps()} />);
    const fileInput = container.querySelector<HTMLInputElement>('#library-source-file');

    expect(screen.getByTestId('new-home-surface')).toHaveTextContent('library-query');
    expect(fileInput).not.toBeNull();
    if (!fileInput) {
      throw new Error('Expected the library source file input.');
    }

    fireEvent.change(fileInput, {
      target: { files: [new File(['source'], 'source.md', { type: 'text/markdown' })] },
    });

    expect(screen.getByTestId('new-home-surface')).toHaveTextContent('new-course:source.md');
  });
});
