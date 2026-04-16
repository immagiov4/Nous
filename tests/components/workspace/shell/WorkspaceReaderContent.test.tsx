// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, test, vi } from 'vitest';
import type { WorkspaceReaderContentModel } from '../../../../components/workspace/shell/types.ts';
import WorkspaceReaderContent from '../../../../components/workspace/shell/WorkspaceReaderContent.tsx';

const buildProps = (
  overrides: Partial<WorkspaceReaderContentModel> = {}
): WorkspaceReaderContentModel => ({
  activeLaboratoryExercise: null,
  activeSectionAssetsById: {},
  activeSectionImageRefsById: {},
  contentRef: createRef<HTMLDivElement>(),
  isDarkMode: false,
  isFocusMode: false,
  isLoading: false,
  isLaboratoryEvaluating: false,
  isLaboratoryGenerating: false,
  isLaboratoryView: false,
  isMobileViewport: false,
  isQuizSubmitted: false,
  laboratoryActivityMessage: undefined,
  laboratoryErrorMessage: undefined,
  laboratoryStatus: null,
  laboratorySummary: '',
  laboratoryTitle: 'Laboratorio',
  onAddLaboratoryTextAttachment: vi.fn(),
  onAttachLaboratoryFiles: vi.fn(),
  onCompleteSection: vi.fn(),
  onContentClick: vi.fn(),
  onContentContextMenu: vi.fn(),
  onContentPointerDownCapture: vi.fn(),
  onEvaluateActiveLaboratoryExercise: vi.fn(),
  onGenerateLaboratory: vi.fn(),
  onRemoveLaboratoryAttachment: vi.fn(),
  onSelectQuizAnswer: vi.fn(),
  onSetIsQuizSubmitted: vi.fn(),
  onUpdateLaboratoryAttachmentMetadata: vi.fn(),
  onUpdateLaboratoryTextAttachment: vi.fn(),
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
  test('renders inline quiz cards inside the reading column in focus mode', () => {
    render(<WorkspaceReaderContent {...buildProps({ isFocusMode: true })} />);

    expect(screen.getByText('Pausa attiva 1')).toBeInTheDocument();
    expect(screen.queryByTestId('reader-quiz-column')).toBeNull();
    expect(screen.getByText('Completa e Prosegui')).toBeDisabled();
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

  test('renders the laboratory workspace when laboratory view is active', () => {
    render(
      <WorkspaceReaderContent
        {...buildProps({
          activeLaboratoryExercise: {
            attachments: [],
            approachMarkdown: '## Metodo\n\nParti dai requisiti e costruisci una checklist.',
            brief: 'Consegna pratica.',
            evaluation: null,
            exampleMarkdown:
              '## Esempio guidato\n\nSu un caso parallelo, esplicita prima vincoli e primo passo.',
            generatedAt: '2026-03-20T10:00:00.000Z',
            id: 'lab-1',
            internalNotes: [],
            instructionsMarkdown: '## Consegna\n\nScrivi una soluzione.',
            requirements: ['Non ridefinire il caso.', 'Motiva le scelte con evidenze.'],
            sourceChunkIds: ['chunk-1'],
            title: 'Esercizio 1',
            updatedAt: '2026-03-20T10:00:00.000Z',
          },
          isLaboratoryView: true,
          laboratorySourcePageRangeLabel: 'pag. 10-12',
          laboratoryStatus: 'ready',
        })}
      />
    );

    expect(screen.getByText('Esercizio 1')).toBeInTheDocument();
    expect(screen.queryByText('Requisiti del caso')).toBeNull();
    expect(screen.getByText('Come affrontarlo')).toBeInTheDocument();
    expect(screen.getByText('Esempio guidato o indizi')).toBeInTheDocument();
    expect(
      screen.queryByText('Su un caso parallelo, esplicita prima vincoli e primo passo.')
    ).toBeNull();
    expect(screen.getByTestId('laboratory-source-page-range')).toHaveTextContent(
      'Fonte originale: pag. 10-12'
    );
    expect(screen.getByText('Valuta consegna')).toBeDisabled();
  });

  test('opens the guided example section only on demand in laboratory view', () => {
    render(
      <WorkspaceReaderContent
        {...buildProps({
          activeLaboratoryExercise: {
            attachments: [],
            approachMarkdown: '## Metodo\n\nParti dai vincoli.',
            brief: 'Consegna pratica.',
            evaluation: null,
            exampleMarkdown: '## Esempio guidato\n\nApri da qui solo se ti serve un aiuto.',
            generatedAt: '2026-03-20T10:00:00.000Z',
            id: 'lab-1',
            internalNotes: [],
            instructionsMarkdown: '## Consegna\n\nScrivi una soluzione.',
            requirements: [],
            sourceChunkIds: ['chunk-1'],
            title: 'Esercizio 1',
            updatedAt: '2026-03-20T10:00:00.000Z',
          },
          isLaboratoryView: true,
          laboratoryStatus: 'ready',
        })}
      />
    );

    expect(screen.queryByText('Apri da qui solo se ti serve un aiuto.')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Esempio guidato o indizi/i }));

    expect(screen.getByText('Apri da qui solo se ti serve un aiuto.')).toBeInTheDocument();
  });

  test('does not offer full laboratory regeneration from the empty laboratory state', () => {
    render(
      <WorkspaceReaderContent
        {...buildProps({
          isLaboratoryView: true,
          laboratoryStatus: 'ready',
          laboratorySummary: 'Laboratorio gia disponibile.',
        })}
      />
    );

    expect(screen.queryByRole('button', { name: 'Genera laboratorio' })).toBeNull();
    expect(screen.queryByText('Rigenera laboratorio')).toBeNull();
    expect(screen.getByText(/Apri una traccia del laboratorio dalla sidebar/i)).toBeInTheDocument();
  });
});
