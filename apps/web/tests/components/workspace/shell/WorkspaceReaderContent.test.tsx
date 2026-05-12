// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, test, vi } from 'vitest';
import type { WorkspaceReaderContentModel } from '../../../../components/workspace/shell/types.ts';
import WorkspaceReaderContent from '../../../../components/workspace/shell/WorkspaceReaderContent.tsx';
import type { LearningArtifactRenderPayload } from '../../../../types.ts';

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
      exerciseType: 'prediction',
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

const savedSelectionArtifact: LearningArtifactRenderPayload = {
  summary: {
    id: 'project-1:section-1:generated-visual:visual-draft-1',
    kind: 'generated-visual',
    lessonId: 'section-1',
    lessonTitle: 'Lezione test',
    previewMode: 'chip-only',
    projectId: 'project-1',
    projectTitle: 'Corso test',
    title: 'Flashcard interattive',
  },
  visual: {
    code: '<div>Flashcard interattive</div>',
    createdAt: '2026-05-06T10:00:00.000Z',
    id: 'visual-draft-1',
    kind: 'html',
    title: 'Flashcard interattive',
  },
};

describe('WorkspaceReaderContent', () => {
  test('shows a lesson generation skeleton when the selected lesson is not ready yet', () => {
    render(
      <WorkspaceReaderContent
        {...buildProps({
          activeSectionTitle: 'Divide et impera',
          sectionContent: '',
        })}
      />
    );

    expect(screen.getByRole('status')).toHaveTextContent('Generazione lezione...');
    expect(screen.getByText('Divide et impera')).toBeInTheDocument();
    expect(screen.queryByText(/Seleziona una sezione/i)).toBeNull();
  });

  test('renders inline quiz cards inside the reading column in focus mode', () => {
    render(<WorkspaceReaderContent {...buildProps({ isFocusMode: true })} />);

    expect(screen.getByText(/Pausa attiva 1 - Previsione/i)).toBeInTheDocument();
    expect(screen.queryByTestId('reader-quiz-column')).toBeNull();
    expect(screen.getByText('Completa e Prosegui')).toHaveAttribute('aria-disabled', 'true');
  });

  test('keeps the source page range appended after the lesson body with inline questions active', () => {
    const { container } = render(
      <WorkspaceReaderContent
        {...buildProps({
          sourcePageRangeLabel: 'pag. 10-12',
        })}
      />
    );

    const renderedText = container.textContent || '';
    expect(renderedText).toContain('Fonte originale: pag. 10-12');
    expect(renderedText.indexOf('Contenuto')).toBeLessThan(
      renderedText.indexOf('Fonte originale: pag. 10-12')
    );
    expect(container.querySelector('[data-testid="reader-source-page-range"]')).toBeNull();
  });

  test('enables lesson completion once all inline questions have been answered', () => {
    render(
      <WorkspaceReaderContent
        {...buildProps({
          quizAnswers: [0],
        })}
      />
    );

    expect(screen.getByText('Completa e Prosegui')).toBeEnabled();
    expect(screen.getByText('Corretta')).toBeInTheDocument();
  });

  test('renders artifacts saved on selection annotations in the lesson artifact section', () => {
    render(
      <WorkspaceReaderContent
        {...buildProps({
          currentLessonArtifactPayloads: [savedSelectionArtifact],
          sectionAnnotations: [
            {
              artifactRefs: [
                {
                  artifactId: 'project-1:section-1:generated-visual:visual-draft-1',
                  kind: 'generated-visual',
                  title: 'Flashcard interattive',
                },
              ],
              createdAt: '2026-05-06T10:00:00.000Z',
              id: 'annotation-1',
              note: '',
              updatedAt: '2026-05-06T10:00:00.000Z',
            },
          ],
        })}
      />
    );

    expect(screen.getByRole('heading', { name: 'Artefatti' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Apri Flashcard interattive/i })).toBeInTheDocument();
  });

  test('keeps saved draft artifacts visible even when they are no longer attached to a note', () => {
    render(
      <WorkspaceReaderContent
        {...buildProps({
          currentLessonArtifactPayloads: [savedSelectionArtifact],
          sectionAnnotations: [],
        })}
      />
    );

    expect(screen.getByRole('heading', { name: 'Artefatti' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Apri Flashcard interattive/i })).toBeInTheDocument();
  });
});
