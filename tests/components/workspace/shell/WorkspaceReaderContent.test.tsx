// @vitest-environment jsdom
import { createRef } from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';

import WorkspaceReaderContent from '../../../../components/workspace/shell/WorkspaceReaderContent.tsx';
import type { WorkspaceReaderContentModel } from '../../../../components/workspace/shell/types.ts';

const buildProps = (
  overrides: Partial<WorkspaceReaderContentModel> = {}
): WorkspaceReaderContentModel => ({
  activeSectionAssetsById: {},
  activeSectionImageRefsById: {},
  contentRef: createRef<HTMLDivElement>(),
  isDarkMode: false,
  isFocusMode: false,
  isLoading: false,
  isMobileViewport: false,
  isQuizSubmitted: false,
  onCompleteSection: vi.fn(),
  onContentClick: vi.fn(),
  onContentContextMenu: vi.fn(),
  onContentPointerDownCapture: vi.fn(),
  onSelectQuizAnswer: vi.fn(),
  onSetIsQuizSubmitted: vi.fn(),
  quiz: [
    {
      question: 'Domanda finale?',
      options: ['A', 'B', 'C', 'D'],
      correctIndex: 0,
    },
  ],
  quizAnswers: [-1],
  scrollContainerRef: createRef<HTMLDivElement>(),
  sectionAnnotations: [],
  sectionContent: '# Lezione\n\nContenuto',
  ...overrides,
});

describe('WorkspaceReaderContent', () => {
  test('keeps the quiz column aligned with the reading text width in focus mode', () => {
    render(<WorkspaceReaderContent {...buildProps({ isFocusMode: true })} />);

    expect(screen.getByTestId('reader-quiz-column')).toHaveClass('max-w-[76ch]');
    expect(screen.getByTestId('reader-quiz-column')).toHaveClass('w-full');
  });

  test('keeps the quiz column aligned with the reading text width in standard mode', () => {
    render(<WorkspaceReaderContent {...buildProps({ isFocusMode: false })} />);

    expect(screen.getByTestId('reader-quiz-column')).toHaveClass('max-w-[82ch]');
    expect(screen.getByTestId('reader-quiz-column')).toHaveClass('w-full');
  });
});
