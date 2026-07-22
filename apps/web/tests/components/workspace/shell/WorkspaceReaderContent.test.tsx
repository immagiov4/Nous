// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { WorkspaceReaderContentModel } from '../../../../components/workspace/shell/types.ts';
import WorkspaceReaderContent from '../../../../components/workspace/shell/WorkspaceReaderContent.tsx';
import type { ApplicationExerciseNode, LearningArtifactRenderPayload } from '../../../../types.ts';

const youtubePolicyMocks = vi.hoisted(() => ({
  getYouTubeVideoClipsEnabled: vi.fn(async () => true),
}));

vi.mock('../../../../services/openrouter/youtubeResearchClient.ts', () => youtubePolicyMocks);

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
  learningAids: [],
  onAdvanceSection: vi.fn(),
  onCompleteSection: vi.fn(),
  onAttachExerciseFiles: vi.fn(),
  onContentClick: vi.fn(),
  onContentContextMenu: vi.fn(),
  onContentPointerDownCapture: vi.fn(),
  onSaveLearningAids: vi.fn(async () => true),
  onRequestExerciseFeedback: vi.fn(),
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
  ttsTextPicker: {
    hoveredChunkIndex: null,
    isActive: false,
    overlayRects: [],
  },
  ...overrides,
});

const buildApplicationExercise = (
  overrides: Partial<ApplicationExerciseNode> = {}
): ApplicationExerciseNode => ({
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
  beforeEach(() => {
    globalThis.localStorage.clear();
    youtubePolicyMocks.getYouTubeVideoClipsEnabled.mockResolvedValue(true);
  });

  test('shows a lesson generation skeleton when the selected lesson is not ready yet', () => {
    const { container } = render(
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
    expect(container.firstElementChild).toHaveClass('overflow-y-auto');
    expect(container.firstElementChild).toHaveStyle({ touchAction: 'pan-y' });
  });

  test('renders inline quiz cards inside the reading column in focus mode', () => {
    render(<WorkspaceReaderContent {...buildProps({ isFocusMode: true })} />);

    expect(screen.getByText(/Pausa attiva 1 - Previsione/i)).toBeInTheDocument();
    expect(screen.queryByTestId('reader-quiz-column')).toBeNull();
    expect(screen.getByText('Prosegui')).toHaveAttribute('aria-disabled', 'true');
  });

  test('renders typed lesson blocks as the primary ordered lesson content', () => {
    render(
      <WorkspaceReaderContent
        {...buildProps({
          activeSectionTitle: 'Trasformazioni',
          activeSectionGeneratedVisualsById: {
            'visual-1': {
              code: '<div>Gerarchia delle pose</div>',
              createdAt: '2026-07-22T18:00:00.000Z',
              id: 'visual-1',
              kind: 'html',
              title: 'Gerarchia delle pose',
            },
          },
          quiz: [],
          sectionContent: 'Questo fallback legacy non deve apparire.',
          sourcePageRangeLabel: 'pagine 4-6',
          sectionContentBlocks: [
            { type: 'markdown', markdown: '## Coordinate locali\n\nPrima spiegazione.' },
            {
              type: 'inline-quiz',
              quiz: {
                correctIndex: 1,
                exerciseType: 'application-card',
                options: ['Globale', 'Locale', 'Vista', 'Schermo'],
                question: 'In quale spazio parte il vettore?',
              },
            },
            {
              type: 'generated-visual',
              slotId: 'slot-001',
              visualId: 'visual-1',
            },
            { type: 'markdown', markdown: '## Composizione\n\nSeconda spiegazione.' },
          ],
        })}
      />
    );

    expect(screen.getByText('Coordinate locali')).toBeInTheDocument();
    expect(screen.getByText('In quale spazio parte il vettore?')).toBeInTheDocument();
    expect(screen.getByText('Composizione')).toBeInTheDocument();
    expect(screen.getByTitle('Gerarchia delle pose')).toBeInTheDocument();
    expect(screen.getAllByText(/Fonte originale: pagine 4-6/)).toHaveLength(1);
    expect(screen.queryByText('Questo fallback legacy non deve apparire.')).toBeNull();
  });

  test('resolves a typed YouTube chapter at its ordered block position', async () => {
    render(
      <WorkspaceReaderContent
        {...buildProps({
          quiz: [],
          quizAnswers: [],
          sectionContent: '',
          sectionContentBlocks: [
            { type: 'markdown', markdown: 'Osserva la rotazione locale.' },
            {
              type: 'youtube-clips',
              clips: [
                {
                  endSeconds: 45,
                  sourceIndex: 0,
                  startSeconds: 20,
                  title: 'Dal riferimento locale al genitore',
                },
              ],
            },
            { type: 'markdown', markdown: 'Ora confrontala con quella globale.' },
          ],
          lessonSources: [
            {
              title: 'Video completo sui quaternioni',
              url: 'https://www.youtube.com/watch?v=M7lc1UVf-VE',
              youtubeTranscript: {
                ranges: [{ startSeconds: 0, endSeconds: 90 }],
                text: 'Transcript timestampato.',
              },
            },
          ],
        })}
      />
    );

    const video = await screen.findByRole('tabpanel', {
      name: 'Dal riferimento locale al genitore',
    });
    expect(
      screen.getByText('Osserva la rotazione locale.').compareDocumentPosition(video) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  test('treats typed blocks as ready content even without legacy markdown', () => {
    render(
      <WorkspaceReaderContent
        {...buildProps({
          activeSectionTitle: 'Quaternioni',
          quiz: [],
          quizAnswers: [],
          sectionContent: '',
          sectionContentBlocks: [{ type: 'markdown', markdown: 'La lezione tipizzata è pronta.' }],
        })}
      />
    );

    expect(screen.getByText('La lezione tipizzata è pronta.')).toBeInTheDocument();
    expect(screen.queryByRole('status')).toBeNull();
  });

  test('materializes annotations before rendering lesson chunks', () => {
    const sectionContent =
      '# Lezione\n\nPrima **grassetto**, poi *corsivo* e [un link](https://example.com).';
    const selectionStart = sectionContent.indexOf('Prima');
    const { container } = render(
      <WorkspaceReaderContent
        {...buildProps({
          quiz: [],
          quizAnswers: [],
          sectionAnnotations: [
            {
              anchor: {
                kind: 'selection',
                selector: {
                  end: sectionContent.length,
                  exact: 'Prima grassetto, poi corsivo e un link.',
                  prefix: 'Lezione',
                  start: selectionStart,
                  suffix: '',
                },
              },
              createdAt: '2026-07-14T10:00:00.000Z',
              id: 'annotation-detached',
              note: '',
              updatedAt: '2026-07-14T10:00:00.000Z',
            },
          ],
          sectionContent,
        })}
      />
    );

    const mark = container.querySelector('mark[data-nous-annotation-id="annotation-detached"]');
    expect(mark).toHaveTextContent('Prima grassetto, poi corsivo e un link.');
    expect(mark?.querySelector('strong')).toHaveTextContent('grassetto');
    expect(mark?.querySelector('em')).toHaveTextContent('corsivo');
    expect(mark?.querySelector('a')).toHaveAttribute('href', 'https://example.com');
  });

  test('keeps the desktop reading column centered when contextual learning aids exist', () => {
    render(
      <WorkspaceReaderContent
        {...buildProps({
          learningAids: [
            {
              id: 'learning-aid-definition-protocollo',
              kind: 'definition',
              title: 'Protocollo',
              content: 'Regole condivise per scambiare messaggi.',
            },
          ],
        })}
      />
    );

    expect(screen.queryByRole('complementary', { name: 'Concetti chiave' })).toBeNull();
    expect(screen.queryByText('Regole condivise per scambiare messaggi.')).toBeNull();
  });

  test('keeps learning aids collapsed in a mobile bottom sheet until requested', async () => {
    const user = userEvent.setup();

    render(
      <WorkspaceReaderContent
        {...buildProps({
          isMobileViewport: true,
          learningAids: [
            {
              id: 'learning-aid-formula-latenza',
              kind: 'formula',
              title: 'Latenza totale',
              content: 'T = T_prop + T_tx',
            },
          ],
        })}
      />
    );

    expect(screen.queryByText('T = T_prop + T_tx')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Apri concetti chiave' }));

    expect(screen.getByRole('dialog', { name: 'Concetti chiave' })).toBeInTheDocument();
    expect(screen.queryByText('T = T_prop + T_tx')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Espandi Latenza totale' }));
    expect(screen.getByText('T = T_prop + T_tx')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Chiudi concetti chiave' }));
    expect(screen.queryByRole('dialog', { name: 'Concetti chiave' })).toBeNull();
  });

  test('handles context-menu requests from empty space around the reading column', () => {
    const contentRef = createRef<HTMLDivElement>();
    const onContentContextMenu = vi.fn();

    render(
      <WorkspaceReaderContent
        {...buildProps({
          contentRef,
          onContentContextMenu,
        })}
      />
    );

    expect(contentRef.current).not.toBeNull();
    fireEvent.contextMenu(contentRef.current as HTMLDivElement);

    expect(onContentContextMenu).toHaveBeenCalledTimes(1);
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

  test('shows persisted lesson sources while refusing unsafe source links', () => {
    render(
      <WorkspaceReaderContent
        {...buildProps({
          lessonSources: [
            {
              title: 'Documentazione ufficiale',
              url: 'https://example.com/docs',
              note: 'Conferma il comportamento corrente.',
            },
            {
              title: 'Materiale originale',
              url: 'javascript:alert(1)',
              note: 'Lessico del corso.',
            },
          ],
        })}
      />
    );

    expect(screen.getByRole('complementary', { name: 'Fonti della sezione' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Documentazione ufficiale' })).toHaveAttribute(
      'href',
      'https://example.com/docs'
    );
    expect(screen.queryByRole('link', { name: 'Materiale originale' })).toBeNull();
    expect(screen.getByText('Lessico del corso.')).toBeInTheDocument();
  });

  test('loads a validated timestamped YouTube demonstration only after user intent', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <WorkspaceReaderContent
        {...buildProps({
          sectionContent:
            '## Tecnica\n\nOsserva il movimento.\n\n{{YOUTUBE_CLIP_SOURCE:0}}\n\nProva il passaggio.',
          lessonSources: [
            {
              title: 'Ombreggiatura a tratteggio',
              url: 'https://www.youtube.com/watch?v=M7lc1UVf-VE',
              note: 'Mostra il movimento della matita durante il passaggio pratico.',
              youtubeTranscript: {
                ranges: [{ startSeconds: 65, endSeconds: 93 }],
                text: '[01:05-01:33] Traccio le linee di ombra.',
              },
              videoClip: { startSeconds: 65, endSeconds: 92 },
            },
          ],
        })}
      />
    );

    expect(container.querySelector('iframe')).toBeNull();
    await user.click(
      await screen.findByRole('button', { name: 'Riproduci la dimostrazione (1:05–1:32)' })
    );

    const frame = screen.getByTitle('Dimostrazione video: Ombreggiatura a tratteggio');
    expect(frame).toHaveAttribute(
      'src',
      'https://www.youtube-nocookie.com/embed/M7lc1UVf-VE?autoplay=0&controls=1&end=92&playsinline=1&rel=0&start=65'
    );
    expect(frame).toHaveAttribute('loading', 'lazy');
  });

  test('renders a validated YouTube clip at the model-selected inline marker', async () => {
    render(
      <WorkspaceReaderContent
        {...buildProps({
          sectionContent:
            '## Tecnica\n\nOsserva il movimento nel video seguente.\n\n{{YOUTUBE_CLIP_SOURCE:0}}\n\nPoi prova lo stesso passaggio.',
          lessonSources: [
            {
              title: 'Ombreggiatura a tratteggio',
              url: 'https://www.youtube.com/watch?v=M7lc1UVf-VE',
              youtubeTranscript: {
                ranges: [{ startSeconds: 65, endSeconds: 93 }],
                text: '[01:05-01:33] Traccio le linee di ombra.',
              },
              videoClip: { startSeconds: 65, endSeconds: 92 },
            },
          ],
        })}
      />
    );

    const playButton = await screen.findByRole('button', {
      name: 'Riproduci la dimostrazione (1:05–1:32)',
    });
    expect(
      screen.getByText(/Osserva il movimento/).compareDocumentPosition(playButton) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(
      playButton.compareDocumentPosition(screen.getByText(/Poi prova/)) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(screen.getAllByRole('button', { name: /Riproduci la dimostrazione/ })).toHaveLength(1);
  });

  test('groups multiple validated lesson markers into one inline micro-chapter carousel', async () => {
    render(
      <WorkspaceReaderContent
        {...buildProps({
          sectionContent: [
            '## Tecnica',
            '',
            'Osserva il primo movimento.',
            '',
            '{{YOUTUBE_CLIP_SOURCE:0|START:10|END:30}}',
            '',
            'Confronta il secondo movimento.',
            '',
            '{{YOUTUBE_CLIP_SOURCE:0|START:40|END:70}}',
            '',
            'Nota il dettaglio complementare.',
            '',
            '{{YOUTUBE_CLIP_SOURCE:1|START:5|END:20}}',
            '',
            'Applica la sequenza.',
          ].join('\n'),
          lessonSources: [
            {
              title: 'Tecnica completa',
              url: 'https://www.youtube.com/watch?v=M7lc1UVf-VE',
              youtubeTranscript: {
                ranges: [{ startSeconds: 0, endSeconds: 90 }],
                text: 'Transcript della tecnica completa.',
              },
            },
            {
              title: 'Dettaglio complementare',
              url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
              youtubeTranscript: {
                ranges: [{ startSeconds: 0, endSeconds: 30 }],
                text: 'Transcript del dettaglio.',
              },
            },
          ],
        })}
      />
    );

    expect(await screen.findAllByRole('tab')).toHaveLength(3);
    expect(screen.getAllByRole('button', { name: /Riproduci la dimostrazione/ })).toHaveLength(1);
    const tabList = screen.getByRole('tablist', { name: 'Micro-capitoli video' });
    expect(
      screen.getByText(/Osserva il primo movimento/).compareDocumentPosition(tabList) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(
      tabList.compareDocumentPosition(screen.getByText(/Confronta il secondo movimento/)) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  test('uses the writer-selected transcript-backed interval in an inline marker', async () => {
    render(
      <WorkspaceReaderContent
        {...buildProps({
          sectionContent:
            'Osserva il passaggio.\n\n{{YOUTUBE_CLIP_SOURCE:0|START:70|END:88}}\n\nPoi applicalo.',
          lessonSources: [
            {
              title: 'Ombreggiatura a tratteggio',
              url: 'https://www.youtube.com/watch?v=M7lc1UVf-VE',
              youtubeTranscript: {
                ranges: [{ startSeconds: 65, endSeconds: 93 }],
                text: '[01:05-01:33] Traccio le linee di ombra.',
              },
              videoClip: { startSeconds: 65, endSeconds: 92 },
            },
          ],
        })}
      />
    );

    await screen.findByRole('button', { name: 'Riproduci la dimostrazione (1:10–1:28)' });
  });

  test('keeps persisted YouTube clips hidden when the backend policy is disabled', async () => {
    youtubePolicyMocks.getYouTubeVideoClipsEnabled.mockResolvedValue(false);
    render(
      <WorkspaceReaderContent
        {...buildProps({
          lessonSources: [
            {
              title: 'Ombreggiatura a tratteggio',
              url: 'https://www.youtube.com/watch?v=M7lc1UVf-VE',
              videoClip: { startSeconds: 65, endSeconds: 92 },
            },
          ],
        })}
      />
    );

    await waitFor(() => expect(youtubePolicyMocks.getYouTubeVideoClipsEnabled).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: /Riproduci la dimostrazione/ })).toBeNull();
  });

  test('renders legacy lesson bibliographies only through structured section sources', () => {
    render(
      <WorkspaceReaderContent
        {...buildProps({
          sectionContent:
            '## Corpo della lezione\n\nSpiegazione.\n\n## Fonti essenziali\n\n- Vecchia fonte duplicata',
          lessonSources: [{ title: 'Fonte canonica', url: 'https://example.com/source' }],
        })}
      />
    );

    expect(screen.getByText('Corpo della lezione')).toBeInTheDocument();
    expect(screen.queryByText('Vecchia fonte duplicata')).toBeNull();
    expect(screen.getByRole('complementary', { name: 'Fonti della sezione' })).toHaveTextContent(
      'Fonte canonica'
    );
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

  test('persists dismissal of the context hint banner', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<WorkspaceReaderContent {...buildProps()} />);

    await user.click(
      screen.getByRole('button', { name: /Nascondi suggerimento selezione testo/i })
    );
    expect(
      screen.queryByText(/Seleziona un passaggio e fai click destro per chiedere spiegazioni/i)
    ).toBeNull();

    rerender(<WorkspaceReaderContent {...buildProps()} />);

    expect(
      screen.queryByText(/Seleziona un passaggio e fai click destro per chiedere spiegazioni/i)
    ).toBeNull();
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

  test('requests feedback with the current editor draft before autosave commits it', async () => {
    const user = userEvent.setup();
    const onRequestExerciseFeedback = vi.fn();

    render(
      <WorkspaceReaderContent
        {...buildProps({
          activeExercise: buildApplicationExercise(),
          activeSectionTitle: null,
          onRequestExerciseFeedback,
          quiz: [],
          quizAnswers: [],
          sectionContent: '',
        })}
      />
    );

    await user.type(screen.getByRole('textbox'), 'Bozza corrente non ancora salvata');
    await user.click(screen.getByRole('button', { name: 'Richiedi riscontro' }));

    expect(onRequestExerciseFeedback).toHaveBeenCalledOnce();
    expect(onRequestExerciseFeedback).toHaveBeenCalledWith(
      'exercise-1',
      'Bozza corrente non ancora salvata'
    );
  });

  test('exposes evaluation progress and renders feedback or a stable error', () => {
    const exercise = buildApplicationExercise({ internalText: 'Consegna pronta' });
    const { rerender } = render(
      <WorkspaceReaderContent
        {...buildProps({
          activeExercise: exercise,
          activeSectionTitle: null,
          exerciseFeedbackStatus: 'Valutazione della consegna',
          isEvaluatingExercise: true,
          quiz: [],
          quizAnswers: [],
          sectionContent: '',
        })}
      />
    );

    const busyButton = screen.getByRole('button', { name: 'Valutazione in corso...' });
    expect(busyButton).toBeDisabled();
    expect(busyButton).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('status')).toHaveTextContent('Valutazione della consegna');

    rerender(
      <WorkspaceReaderContent
        {...buildProps({
          activeExercise: buildApplicationExercise({
            internalText: 'Consegna pronta',
            currentFeedback: {
              evaluatedAt: '2026-05-12T12:05:00.000Z',
              score: 84,
              qualitativeLabel: 'Obiettivo raggiunto',
              summary: 'La consegna applica correttamente il metodo.',
              strengths: ['Distingue host e servizi'],
              improvements: ['Motiva una dipendenza'],
              caveats: ['Nessun ambiente eseguibile allegato'],
            },
          }),
          activeSectionTitle: null,
          exerciseFeedbackError: 'Valutazione non disponibile. Riprova.',
          quiz: [],
          quizAnswers: [],
          sectionContent: '',
        })}
      />
    );

    expect(screen.getByRole('alert')).toHaveTextContent('Valutazione non disponibile. Riprova.');
    expect(screen.getByText('Score 84/100')).toBeInTheDocument();
    expect(screen.getByText('La consegna applica correttamente il metodo.')).toBeInTheDocument();
    expect(screen.getByText('Distingue host e servizi')).toBeInTheDocument();
    expect(screen.getByText('Motiva una dipendenza')).toBeInTheDocument();
    expect(screen.getByText('Nessun ambiente eseguibile allegato')).toBeInTheDocument();
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
