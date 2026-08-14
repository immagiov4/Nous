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

  test('keeps a failed visual inline and retries only that slot', async () => {
    let finishRetry: ((succeeded: boolean) => void) | undefined;
    const onRetryGeneratedVisual = vi.fn(
      () =>
        new Promise<boolean>(resolve => {
          finishRetry = resolve;
        })
    );
    render(
      <WorkspaceReaderContent
        {...buildProps({
          onRetryGeneratedVisual,
          quiz: [],
          sectionContentBlocks: [
            { type: 'markdown', markdown: 'Prima spiegazione.' },
            {
              type: 'generated-visual',
              slotId: 'slot-001',
              retryPlan: {
                slotId: 'slot-001',
                complexity: 'simple',
                concept: 'Confronto',
                coverage: 'single_complex',
                coverageRationale: 'Mostra il confronto.',
                factualRequirements: ['Due stati distinti'],
                interactionLevel: 'none',
                pedagogicalGoal: 'Rendere visibile il confronto.',
                reason: 'Il testo non basta.',
                requiresDepiction: true,
                visualDirection: 'Due stati affiancati.',
                visualType: 'illustrative_image',
              },
            },
            { type: 'markdown', markdown: 'Spiegazione successiva.' },
          ],
        })}
      />
    );

    expect(screen.getByText('Esempio visuale non generato')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Riprova' }));
    expect(onRetryGeneratedVisual).toHaveBeenCalledWith(
      expect.objectContaining({ slotId: 'slot-001' })
    );
    expect(screen.getByText('Generazione esempio visuale…')).toBeInTheDocument();
    finishRetry?.(false);
    await waitFor(() =>
      expect(screen.getByText('Esempio visuale non generato')).toBeInTheDocument()
    );
    expect(screen.getByRole('button', { name: 'Riprova' })).toBeEnabled();
    expect(screen.getByText('Spiegazione successiva.')).toBeInTheDocument();
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
                segments: [{ startSeconds: 0, endSeconds: 90, text: 'Transcript timestampato.' }],
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

  test('keeps long external source titles on one line while preserving the full title', () => {
    const longTitle =
      'Una documentazione ufficiale con un titolo volutamente molto lungo per la colonna di lettura';

    render(
      <WorkspaceReaderContent
        {...buildProps({
          lessonSources: [{ title: longTitle, url: 'https://example.com/docs' }],
        })}
      />
    );

    expect(screen.getByRole('link', { name: longTitle })).toHaveAttribute('title', longTitle);
    expect(screen.getByRole('link', { name: longTitle })).toHaveClass('truncate');
  });

  test('loads a validated timestamped YouTube demonstration without an extra play gate', async () => {
    render(
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
                segments: [
                  { startSeconds: 65, endSeconds: 93, text: 'Traccio le linee di ombra.' },
                ],
              },
              videoClip: { startSeconds: 65, endSeconds: 92 },
            },
          ],
        })}
      />
    );

    const frame = await screen.findByTitle('Dimostrazione video: Ombreggiatura a tratteggio');
    expect(frame).toHaveAttribute(
      'src',
      'https://www.youtube-nocookie.com/embed/M7lc1UVf-VE?autoplay=0&controls=1&end=92&enablejsapi=1&playsinline=1&rel=0&start=65'
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
                segments: [
                  { startSeconds: 65, endSeconds: 93, text: 'Traccio le linee di ombra.' },
                ],
              },
              videoClip: { startSeconds: 65, endSeconds: 92 },
            },
          ],
        })}
      />
    );

    const frame = await screen.findByTitle('Dimostrazione video: Ombreggiatura a tratteggio');
    expect(
      screen.getByText(/Osserva il movimento/).compareDocumentPosition(frame) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(
      frame.compareDocumentPosition(screen.getByText(/Poi prova/)) &
        Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Riproduci la dimostrazione/ })).toBeNull();
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
                segments: [
                  { startSeconds: 0, endSeconds: 90, text: 'Transcript della tecnica completa.' },
                ],
              },
            },
            {
              title: 'Dettaglio complementare',
              url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
              youtubeTranscript: {
                segments: [{ startSeconds: 0, endSeconds: 30, text: 'Transcript del dettaglio.' }],
              },
            },
          ],
        })}
      />
    );

    expect(await screen.findAllByRole('tab')).toHaveLength(3);
    expect(screen.getAllByTitle(/Dimostrazione video:/)).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /Riproduci la dimostrazione/ })).toBeNull();
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
                segments: [
                  { startSeconds: 65, endSeconds: 93, text: 'Traccio le linee di ombra.' },
                ],
              },
              videoClip: { startSeconds: 65, endSeconds: 92 },
            },
          ],
        })}
      />
    );

    const frame = await screen.findByTitle('Dimostrazione video: Ombreggiatura a tratteggio');
    expect(frame).toHaveAttribute('src', expect.stringContaining('start=70'));
    expect(frame).toHaveAttribute('src', expect.stringContaining('end=88'));
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
    expect(screen.queryByTitle(/Dimostrazione video:/)).toBeNull();
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

  test('does not repeat a cited course document in the generic source list', () => {
    render(
      <WorkspaceReaderContent
        {...buildProps({
          documentSourceReferences: [
            {
              chunkIds: ['source-course:chunk-1'],
              file: {
                data: '',
                mimeType: 'application/pdf',
                name: 'course.pdf',
                sourceId: 'source-course',
              },
              kind: 'pdf',
              name: 'course.pdf',
              pageStart: 4,
              sourceId: 'source-course',
            },
          ],
          lessonSources: [
            { title: 'course.pdf', note: 'Materiale originale del corso' },
            { title: 'Fonte esterna', url: 'https://example.com/source' },
          ],
        })}
      />
    );

    expect(screen.getAllByText('course.pdf')).toHaveLength(1);
    expect(screen.queryByText('Materiale originale del corso')).toBeNull();
    expect(screen.getByText('Fonte esterna')).toBeInTheDocument();
  });

  test('does not render an unresolved original course source as a generic citation', () => {
    render(
      <WorkspaceReaderContent
        {...buildProps({
          documentSourceReferences: [],
          lessonSources: [
            {
              title: 'Understanding Deep Learning -- raw metadata -- missing.pdf',
              note: 'Materiale originale del corso',
            },
          ],
        })}
      />
    );

    expect(screen.queryByRole('complementary', { name: 'Fonti della sezione' })).toBeNull();
    expect(screen.queryByText(/raw metadata/u)).toBeNull();
    expect(screen.queryByText('Materiale originale del corso')).toBeNull();
  });

  test('keeps an external source whose identifier is unrelated to course documents', () => {
    render(
      <WorkspaceReaderContent
        {...buildProps({
          documentSourceReferences: [],
          lessonSources: [
            {
              sourceId: 'external-video',
              title: 'Approfondimento esterno',
              url: 'https://example.com/video',
            },
          ],
        })}
      />
    );

    expect(screen.getByText('Approfondimento esterno')).toBeInTheDocument();
  });

  test('does not repeat a structured document page range inline', () => {
    render(
      <WorkspaceReaderContent
        {...buildProps({
          documentSourceReferences: [
            {
              chunkIds: ['source-course:chunk-1'],
              file: {
                data: '',
                mimeType: 'application/pdf',
                name: 'course.pdf',
                sourceId: 'source-course',
              },
              kind: 'pdf',
              name: 'course.pdf',
              pageEnd: 24,
              pageStart: 10,
              sourceId: 'source-course',
            },
          ],
          sourcePageRangeLabel: 'pag. 10-24',
        })}
      />
    );

    expect(screen.queryByText('Fonte originale: pag. 10-24')).toBeNull();
    expect(screen.getByRole('complementary', { name: 'Fonti della sezione' })).toHaveTextContent(
      'Pagine 10-24'
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

  test('renders a saved visual attached to the whole lesson only once in one artifact section', () => {
    const secondSavedArtifact: LearningArtifactRenderPayload = {
      ...savedSelectionArtifact,
      summary: {
        ...savedSelectionArtifact.summary,
        id: 'project-1:section-1:generated-visual:visual-draft-2',
        title: 'Seconda mappa interattiva',
      },
      visual: {
        ...savedSelectionArtifact.visual,
        id: 'visual-draft-2',
        title: 'Seconda mappa interattiva',
      },
    };
    render(
      <WorkspaceReaderContent
        {...buildProps({
          activeSectionGeneratedVisualsById: {
            'visual-draft-1': savedSelectionArtifact.visual,
            'visual-draft-2': secondSavedArtifact.visual,
          },
          currentLessonArtifactPayloads: [savedSelectionArtifact, secondSavedArtifact],
          sectionAnnotations: [
            {
              anchor: { kind: 'lesson' },
              artifactRefs: [
                {
                  artifactId: 'legacy:generated-visual:visual-draft-1',
                  kind: 'generated-visual',
                  title: 'Flashcard interattive',
                },
              ],
              createdAt: '2026-05-06T10:00:00.000Z',
              id: 'lesson-annotation-1',
              note: '',
              updatedAt: '2026-05-06T10:00:00.000Z',
            },
            {
              anchor: { kind: 'lesson' },
              artifactRefs: [
                {
                  artifactId: 'legacy:generated-visual:visual-draft-2',
                  kind: 'generated-visual',
                  title: 'Seconda mappa interattiva',
                },
              ],
              createdAt: '2026-05-06T10:01:00.000Z',
              id: 'lesson-annotation-2',
              note: '',
              updatedAt: '2026-05-06T10:01:00.000Z',
            },
          ],
        })}
      />
    );

    expect(screen.getAllByRole('heading', { name: 'Artefatti' })).toHaveLength(1);
    expect(screen.queryByRole('heading', { name: 'Artefatti della lezione' })).toBeNull();
    expect(screen.getAllByRole('button', { name: /Apri Flashcard interattive/i })).toHaveLength(1);
    const artifactButtons = [
      screen.getByRole('button', { name: /Apri Flashcard interattive/i }),
      screen.getByRole('button', { name: /Apri Seconda mappa interattiva/i }),
    ];
    expect(artifactButtons[0].closest('.grid')).toBe(artifactButtons[1].closest('.grid'));
    expect(artifactButtons[0].closest('.grid')).toHaveClass('sm:grid-cols-2');
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
