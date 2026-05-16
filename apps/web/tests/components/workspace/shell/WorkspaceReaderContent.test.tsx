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
  hasNextSection: false,
  isDarkMode: false,
  isFocusMode: false,
  isLoading: false,
  isMobileViewport: false,
  isQuizSubmitted: false,
  onAdvanceSection: vi.fn(),
  onCompleteSection: vi.fn(),
  onAttachExerciseFiles: vi.fn(),
  onContentClick: vi.fn(),
  onContentContextMenu: vi.fn(),
  onContentPointerDownCapture: vi.fn(),
  onSelectQuizAnswer: vi.fn(),
  onRemoveExerciseAttachment: vi.fn(),
  onSetIsQuizSubmitted: vi.fn(),
  onUpdateExerciseInternalText: vi.fn(),
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
    expect(screen.getByText('Prosegui')).toHaveAttribute('aria-disabled', 'true');
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

  test('allows advancing without completion when a later lesson exists', () => {
    const onAdvanceSection = vi.fn();

    render(
      <WorkspaceReaderContent
        {...buildProps({
          hasNextSection: true,
          onAdvanceSection,
        })}
      />
    );

    screen.getByText('Prosegui').click();

    expect(onAdvanceSection).toHaveBeenCalledTimes(1);
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

  test('renders the selected application exercise brief instead of a lesson skeleton', () => {
    render(
      <WorkspaceReaderContent
        {...buildProps({
          activeExercise: {
            kind: 'exercise',
            id: 'exercise-1',
            title: 'Laboratorio pratico: Modulo operativo',
            description: 'Applica il modulo in un caso realistico.',
            assessedObjective: 'Dimostrare di saper mappare host, servizi e flussi.',
            brief: 'Disegna una mappa minima con host, IP, servizi e dipendenze.',
            attachments: [],
            currentFeedback: null,
            isCompleted: false,
            feedbackStale: false,
            updatedAt: '2026-05-12T12:00:00.000Z',
          },
          activeSectionTitle: null,
          quiz: [],
          quizAnswers: [],
          sectionContent: '',
        })}
      />
    );

    expect(
      screen.getByRole('heading', { name: 'Laboratorio pratico: Modulo operativo' })
    ).toBeInTheDocument();
    expect(screen.getByText(/Disegna una mappa minima/i)).toBeInTheDocument();
    expect(screen.queryByRole('status')).toBeNull();
  });

  test('hides legacy objective sections from application exercise briefs', () => {
    const { container } = render(
      <WorkspaceReaderContent
        {...buildProps({
          activeExercise: {
            kind: 'exercise',
            id: 'exercise-1',
            title: 'Laboratorio pratico: Modulo operativo',
            description: 'Applica il modulo in un caso realistico.',
            assessedObjective: 'Dimostrare di saper mappare host, servizi e flussi.',
            brief:
              'Laboratorio pratico\n\nObiettivo operativo\n\nDimostrare di saper applicare il modulo.\n\nConsegna\n\nDisegna una mappa minima.',
            attachments: [],
            currentFeedback: null,
            isCompleted: false,
            feedbackStale: false,
            updatedAt: '2026-05-12T12:00:00.000Z',
          },
          activeSectionTitle: null,
          quiz: [],
          quizAnswers: [],
          sectionContent: '',
        })}
      />
    );

    expect(container).not.toHaveTextContent(/Obiettivo operativo/i);
    expect(container).not.toHaveTextContent(/Dimostrare di saper applicare/i);
    expect(screen.getByText(/Disegna una mappa minima/i)).toBeInTheDocument();
  });
});
