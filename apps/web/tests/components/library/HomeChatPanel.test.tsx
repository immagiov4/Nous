// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UIMessage } from 'ai';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import HomeChatPanel from '../../../components/library/HomeChatPanel.tsx';
import type {
  LearningArtifactRenderPayload,
  LibraryContextRef,
  LibraryFolder,
  LibraryPlacement,
  LibraryScopeSummary,
  LibraryTree,
  SavedProjectMeta,
} from '../../../types.ts';

const project: SavedProjectMeta = {
  id: 'project-1',
  title: 'Corso TypeScript',
  sourceKind: 'document',
  createdAt: '2026-04-01T10:00:00.000Z',
  updatedAt: '2026-04-01T10:00:00.000Z',
  lastOpenedAt: '2026-04-01T10:00:00.000Z',
  lessonCount: 6,
  completedCount: 2,
  exerciseCount: 0,
  completedExercises: 0,
  hasSourceFile: true,
  coverLabel: 'PDF',
  syncState: 'local-only',
};

const folder: LibraryFolder = {
  id: 'folder-1',
  name: 'Frontend',
  parentFolderId: null,
  createdAt: '2026-04-01T10:00:00.000Z',
  updatedAt: '2026-04-01T10:00:00.000Z',
  order: 1,
};

const placement: LibraryPlacement = {
  projectId: project.id,
  folderId: folder.id,
  order: 1,
  updatedAt: '2026-04-01T10:00:00.000Z',
};

const libraryTree: LibraryTree = {
  descendantProjectIdsByFolderId: {
    [folder.id]: [project.id],
  },
  folderById: {
    [folder.id]: folder,
  },
  placementByProjectId: {
    [project.id]: placement,
  },
  rootNodes: [
    {
      id: folder.id,
      kind: 'folder',
      order: folder.order,
      folder,
      descendantProjectIds: [project.id],
      children: [
        {
          id: project.id,
          kind: 'project',
          order: placement.order,
          project,
        },
      ],
    },
  ],
};

const libraryScopeSummary: LibraryScopeSummary = {
  attachedFolderIds: [],
  attachedProjectIds: [],
  contextLabels: [],
  isWholeLibraryScope: true,
  scopeProjectIds: [project.id],
  scopeSummary: 'Intero archivio server (1 corsi disponibili).',
};

const libraryMessages: UIMessage[] = [
  {
    id: 'lib-1',
    role: 'assistant',
    parts: [
      {
        type: 'text',
        text: 'Riassunto libreria',
        state: 'done',
      },
    ],
  } as UIMessage,
];

const artifactPayload: LearningArtifactRenderPayload = {
  image: {
    id: 'pdf-img-1',
    mimeType: 'image/png',
    dataUrl: 'data:image/png;base64,abc',
    caption: 'Schema ER',
    textBefore: '',
    textAfter: '',
    sourceOrder: 1,
  },
  summary: {
    id: 'project-1:lesson-1:pdf-image:pdf-img-1',
    kind: 'pdf-image',
    lessonId: 'lesson-1',
    lessonTitle: 'Modello relazionale',
    previewMode: 'thumbnail',
    projectId: 'project-1',
    projectTitle: 'Corso TypeScript',
    title: 'Schema ER',
  },
};

const generatedArtifactPayload: LearningArtifactRenderPayload = {
  summary: {
    id: 'project-1:lesson-1:generated-visual:visual-1',
    kind: 'generated-visual',
    lessonId: 'lesson-1',
    lessonTitle: 'Modello relazionale',
    previewMode: 'thumbnail',
    projectId: 'project-1',
    projectTitle: 'Corso TypeScript',
    title: 'Mappa ER',
  },
  visual: {
    id: 'visual-1',
    title: 'mappa_er',
    kind: 'svg',
    code: '<svg viewBox="0 0 680 120"></svg>',
    createdAt: '2026-05-01T10:00:00.000Z',
  },
};

const setViewportWidth = (width: number) => {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    value: width,
    writable: true,
  });
  window.dispatchEvent(new Event('resize'));
};

const buildProps = () => ({
  assessmentComplete: false,
  assessmentMessages: [{ role: 'model' as const, text: 'Messaggio assessment' }],
  homeChatMode: 'new-course' as const,
  isDarkMode: false,
  isLibraryLoading: false,
  isLibraryModeLoading: false,
  isNewCourseLoading: false,
  libraryAttachedContextRefs: [] as LibraryContextRef[],
  libraryErrorMessage: null,
  libraryMessages,
  libraryArtifactPayloadsByToolCallId: {},
  libraryScopeSummary,
  libraryTree,
  libraryWebSearch: false,
  libraryGenerateArtifacts: false,
  newCourseLoadingStatus: 'Caricamento...',
  onClearPendingFile: vi.fn(),
  onConfirmGenerate: vi.fn(),
  onHomeChatModeChange: vi.fn(),
  onLibraryMessageSend: vi.fn(async () => {}),
  onLibraryWebSearchChange: vi.fn(),
  onLibraryGenerateArtifactsChange: vi.fn(),
  onRemoveLibraryContextRef: vi.fn(),
  onSendAssessmentMessage: vi.fn(async () => {}),
  onToggleLibraryContextRef: vi.fn(),
  onUploadSourceClick: vi.fn(),
  pendingFileName: null,
});

describe('HomeChatPanel', () => {
  beforeEach(() => {
    HTMLElement.prototype.scrollIntoView = vi.fn();
    setViewportWidth(1280);
  });

  test('maps scroll progress to the actual overflow for short, medium, and long chats', () => {
    const props = buildProps();
    const { container, rerender } = render(<HomeChatPanel {...props} />);
    const scrollContainer = container.querySelector('.home-chat-scrollbar');
    expect(scrollContainer).not.toBeNull();
    if (!(scrollContainer instanceof HTMLDivElement)) {
      throw new Error('Expected the home chat scroll container.');
    }

    Object.defineProperties(scrollContainer, {
      clientHeight: { configurable: true, value: 200 },
      scrollHeight: { configurable: true, value: 440 },
    });
    rerender(<HomeChatPanel {...props} scrollProgressOverride={0.5} />);

    expect(scrollContainer.scrollTop).toBe(120);
    expect(scrollContainer.firstElementChild).not.toHaveStyle({ position: 'relative' });
    expect(scrollContainer.firstElementChild).not.toHaveStyle({ top: '-300px' });

    Object.defineProperty(scrollContainer, 'scrollHeight', { configurable: true, value: 1200 });
    rerender(<HomeChatPanel {...props} scrollProgressOverride={1} />);
    expect(scrollContainer.scrollTop).toBe(1000);

    Object.defineProperty(scrollContainer, 'scrollHeight', { configurable: true, value: 120 });
    rerender(<HomeChatPanel {...props} scrollProgressOverride={0.75} />);
    expect(scrollContainer.scrollTop).toBe(0);
  });

  test('shows a compact count and the stable source list for a multi-file course', () => {
    render(
      <HomeChatPanel
        {...buildProps()}
        assessmentMessages={[]}
        pendingFileNames={['Alpha.md', 'zeta.pdf']}
      />
    );

    expect(screen.getByText(/2 (sources selected|fonti selezionate)/i)).toBeInTheDocument();
    expect(screen.getByText('Alpha.md')).toBeInTheDocument();
    expect(screen.getByText('zeta.pdf')).toBeInTheDocument();
  });

  test('renders the course setup surface in the browser language', () => {
    Object.defineProperties(window.navigator, {
      language: { configurable: true, value: 'en-US' },
      languages: { configurable: true, value: ['en-US'] },
    });

    render(<HomeChatPanel {...buildProps()} assessmentMessages={[]} />);

    expect(screen.getByText('Set up a new course')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /New course/i })).toBeInTheDocument();
    expect(screen.getByText('What would you like to learn?')).toBeInTheDocument();
  });

  test('switches between preserved new-course and library threads', async () => {
    const user = userEvent.setup();
    const props = buildProps();
    const { rerender } = render(<HomeChatPanel {...props} />);

    expect(screen.getByTestId('home-chat-mode-copy')).toHaveClass(
      'min-h-[6rem]',
      'sm:min-h-[4.5rem]'
    );

    expect(screen.getByText('Messaggio assessment')).toBeInTheDocument();
    expect(screen.queryByText('Riassunto libreria')).not.toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: /Consulta libreria/i }));

    expect(props.onHomeChatModeChange).toHaveBeenCalledWith('library-query');

    rerender(<HomeChatPanel {...props} homeChatMode="library-query" />);

    expect(screen.getByTestId('home-chat-mode-copy')).toHaveClass(
      'min-h-[6rem]',
      'sm:min-h-[4.5rem]'
    );

    expect(screen.getByText('Riassunto libreria')).toBeInTheDocument();
    expect(screen.queryByText('Messaggio assessment')).not.toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: /Nuovo corso/i }));
    rerender(<HomeChatPanel {...props} homeChatMode="new-course" />);

    expect(screen.getByText('Messaggio assessment')).toBeInTheDocument();
  });

  test('submits new-course messages through the assessment callback', async () => {
    const user = userEvent.setup();
    const props = buildProps();

    render(<HomeChatPanel {...props} />);

    await user.type(
      screen.getByPlaceholderText(/Descrivi l'obiettivo del corso o allega un file/i),
      'Vorrei costruire un corso completo'
    );
    await user.click(screen.getByRole('button', { name: /Inizia/i }));

    expect(props.onSendAssessmentMessage).toHaveBeenCalledWith(
      'Vorrei costruire un corso completo'
    );
  });

  test('opens a mobile attachment sheet in library mode and lets the user select context', async () => {
    setViewportWidth(390);
    const user = userEvent.setup();
    const props = {
      ...buildProps(),
      homeChatMode: 'library-query' as const,
    };

    render(<HomeChatPanel {...props} />);

    await user.click(screen.getByTitle(/Apri esploratore contesto libreria/i));

    expect(screen.getByText(/Scegli il contesto/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Scegli corsi o cartelle/i }));
    await user.click(screen.getByRole('checkbox', { name: /Corso TypeScript/i }));

    expect(props.onToggleLibraryContextRef).toHaveBeenCalledWith({
      id: 'project-1',
      kind: 'project',
      label: 'Corso TypeScript',
    });
  });

  test('closes the mobile attachment sheet before switching back to new-course mode', async () => {
    setViewportWidth(390);
    const user = userEvent.setup();
    const props = {
      ...buildProps(),
      homeChatMode: 'library-query' as const,
    };
    const { rerender } = render(<HomeChatPanel {...props} />);

    await user.click(screen.getByTitle(/Apri esploratore contesto libreria/i));
    expect(screen.getByText(/Scegli il contesto/i)).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: /Nuovo corso/i }));
    expect(props.onHomeChatModeChange).toHaveBeenCalledWith('new-course');

    rerender(<HomeChatPanel {...props} homeChatMode="new-course" />);

    expect(screen.queryByText(/Scegli il contesto/i)).not.toBeInTheDocument();
  });

  test('toggles web search from the library tools menu', async () => {
    const user = userEvent.setup();
    const props = {
      ...buildProps(),
      homeChatMode: 'library-query' as const,
      libraryAttachedContextRefs: [
        {
          id: 'project-1',
          kind: 'project' as const,
          label: 'Corso TypeScript',
        },
      ],
    };

    render(<HomeChatPanel {...props} />);

    await user.click(screen.getByTitle(/Apri strumenti libreria/i));
    await user.click(screen.getByRole('menuitemcheckbox', { name: /Cerca sul web/i }));

    expect(props.onLibraryWebSearchChange).toHaveBeenCalledWith(true);
  });

  test('does not reserve empty composer space in library mode without context chips', () => {
    const props = {
      ...buildProps(),
      homeChatMode: 'library-query' as const,
    };

    render(<HomeChatPanel {...props} />);

    expect(screen.queryByTestId('library-chat-context-bar')).not.toBeInTheDocument();
  });

  test('renders the composer context bar when web search is active', () => {
    const props = {
      ...buildProps(),
      homeChatMode: 'library-query' as const,
      libraryWebSearch: true,
    };

    render(<HomeChatPanel {...props} />);

    expect(screen.getByTestId('library-chat-context-bar')).toBeInTheDocument();
    expect(screen.getByText(/Cerca sul web attiva/i)).toBeInTheDocument();
  });

  test('renders the web-search tool chip for library assistant tool parts', () => {
    const props = {
      ...buildProps(),
      homeChatMode: 'library-query' as const,
      libraryMessages: [
        {
          id: 'lib-tool-1',
          role: 'assistant',
          parts: [
            {
              type: 'tool-searchWeb',
              toolCallId: 'tool-1',
              state: 'output-available',
              input: {
                maxResults: 5,
                query: 'oauth 2.0 vs openid connect',
              },
              output: {
                query: 'oauth 2.0 vs openid connect',
                sources: [
                  {
                    title: 'Example',
                    url: 'https://example.com',
                  },
                ],
                summary: 'Cross-check completato.',
                webSearchRequests: 1,
              },
            },
          ],
        } as UIMessage,
      ],
    };

    render(<HomeChatPanel {...props} />);

    expect(screen.getByText('Ricerca web')).toBeInTheDocument();
  });

  test('keeps the tool strip attached to a multi-message assistant turn', () => {
    const props = {
      ...buildProps(),
      homeChatMode: 'library-query' as const,
      libraryMessages: [
        {
          id: 'assistant-tools',
          role: 'assistant',
          parts: [
            {
              type: 'tool-getProjectStructures',
              toolCallId: 'tool-1',
              state: 'output-available',
              input: {
                projectIds: ['project-1'],
              },
              output: {
                projects: [],
              },
            },
          ],
        } as UIMessage,
        {
          id: 'assistant-text',
          role: 'assistant',
          parts: [
            {
              type: 'text',
              text: 'Ora leggo i dettagli della lezione piu rilevante.',
              state: 'done',
            },
          ],
        } as UIMessage,
      ],
    };

    const { container } = render(<HomeChatPanel {...props} />);

    expect(screen.getByText('Struttura corsi')).toBeInTheDocument();
    expect(
      screen.getByText('Ora leggo i dettagli della lezione piu rilevante.')
    ).toBeInTheDocument();

    const renderedText = container.textContent || '';
    expect(renderedText.indexOf('Struttura corsi')).toBeLessThan(
      renderedText.indexOf('Ora leggo i dettagli della lezione piu rilevante.')
    );
  });

  test('renders artifact cards from learning artifact tool results', () => {
    const props = {
      ...buildProps(),
      homeChatMode: 'library-query' as const,
      libraryArtifactPayloadsByToolCallId: {
        'tool-artifacts-1': [artifactPayload],
      },
      libraryMessages: [
        {
          id: 'assistant-artifacts',
          role: 'assistant',
          parts: [
            {
              type: 'tool-getLearningArtifacts',
              toolCallId: 'tool-artifacts-1',
              state: 'output-available',
              input: {},
              output: {
                artifactCount: 1,
                artifacts: [artifactPayload.summary],
              },
            },
          ],
        } as UIMessage,
      ],
    };

    render(<HomeChatPanel {...props} />);

    expect(screen.getByText('Schema ER')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: /Schema ER/i })).toBeInTheDocument();
  });

  test('renders artifact cards after the assistant text for the same turn', () => {
    const props = {
      ...buildProps(),
      homeChatMode: 'library-query' as const,
      libraryArtifactPayloadsByToolCallId: {
        'tool-artifacts-1': [artifactPayload],
      },
      libraryMessages: [
        {
          id: 'assistant-artifacts',
          role: 'assistant',
          parts: [
            {
              type: 'tool-getLearningArtifacts',
              toolCallId: 'tool-artifacts-1',
              state: 'output-available',
              input: {
                renderMode: 'attachments',
              },
              output: {
                artifactCount: 1,
                artifacts: [artifactPayload.summary],
                renderMode: 'attachments',
                renderedArtifactCount: 1,
              },
            },
            {
              type: 'text',
              text: 'Ecco il grafico richiesto.',
              state: 'done',
            },
          ],
        } as UIMessage,
      ],
    };

    const { container } = render(<HomeChatPanel {...props} />);

    const renderedText = container.textContent || '';
    expect(renderedText.indexOf('Ecco il grafico richiesto.')).toBeLessThan(
      renderedText.indexOf('Schema ER')
    );
  });

  test('passes shared artifact actions to library artifact cards', async () => {
    const user = userEvent.setup();
    const onLibraryArtifactRegenerate = vi.fn();
    const props = {
      ...buildProps(),
      homeChatMode: 'library-query' as const,
      onLibraryArtifactRegenerate,
      libraryArtifactPayloadsByToolCallId: {
        'tool-artifacts-1': [generatedArtifactPayload],
      },
      libraryMessages: [
        {
          id: 'assistant-artifacts',
          role: 'assistant',
          parts: [
            {
              type: 'tool-getLearningArtifacts',
              toolCallId: 'tool-artifacts-1',
              state: 'output-available',
              input: {
                renderMode: 'attachments',
              },
              output: {
                artifactCount: 1,
                artifacts: [generatedArtifactPayload.summary],
                renderMode: 'attachments',
                renderedArtifactCount: 1,
              },
            },
          ],
        } as UIMessage,
      ],
    };

    render(<HomeChatPanel {...props} />);

    await user.click(screen.getByRole('button', { name: /Apri Mappa ER/i }));
    await user.click(screen.getByRole('button', { name: /Rigenera artefatto/i }));
    await user.type(
      screen.getByLabelText(/Istruzioni rigenerazione/i),
      'Rendi il diagramma piu leggibile.'
    );
    await user.click(screen.getByRole('button', { name: /Conferma rigenerazione/i }));

    expect(onLibraryArtifactRegenerate).toHaveBeenCalledWith({
      artifactId: generatedArtifactPayload.summary.id,
      instructions: 'Rendi il diagramma piu leggibile.',
    });
  });

  test('renders a confirmation card for saving generated artifacts into lesson notes', async () => {
    const user = userEvent.setup();
    const onLibraryArtifactNoteApprove = vi.fn(async () => {});
    const onLibraryArtifactNoteReject = vi.fn();
    const props = {
      ...buildProps(),
      homeChatMode: 'library-query' as const,
      onLibraryArtifactNoteApprove,
      onLibraryArtifactNoteReject,
      libraryMessages: [
        {
          id: 'assistant-save-artifact',
          role: 'assistant',
          parts: [
            {
              type: 'tool-requestSaveLearningArtifactNote',
              toolCallId: 'tool-save-artifact',
              state: 'input-available',
              input: {
                artifactIds: ['project-1:lesson-1:generated-visual:visual-1'],
                lessonId: 'lesson-1',
                noteDraft: 'Questa mappa chiarisce il circuito comunicativo.',
                projectId: 'project-1',
                rationale: 'La mappa sara utile per ripassare la lezione.',
              },
            },
          ],
        } as UIMessage,
      ],
    };

    render(<HomeChatPanel {...props} />);

    expect(screen.getByText('Vuoi salvarlo nelle note della lezione?')).toBeInTheDocument();
    expect(
      screen.getByText('Questa mappa chiarisce il circuito comunicativo.')
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Salva nota' }));

    expect(onLibraryArtifactNoteApprove).toHaveBeenCalledWith(
      'tool-save-artifact',
      expect.objectContaining({
        artifactIds: ['project-1:lesson-1:generated-visual:visual-1'],
        lessonId: 'lesson-1',
        projectId: 'project-1',
      })
    );
  });

  test('merges consecutive assistant text bubbles in the same library turn', () => {
    const props = {
      ...buildProps(),
      homeChatMode: 'library-query' as const,
      libraryMessages: [
        {
          id: 'assistant-tools',
          role: 'assistant',
          parts: [
            {
              type: 'tool-getProjectStructures',
              toolCallId: 'tool-1',
              state: 'output-available',
              input: {
                projectIds: ['project-1'],
              },
              output: {
                projects: [],
              },
            },
          ],
        } as UIMessage,
        {
          id: 'assistant-text-1',
          role: 'assistant',
          parts: [
            {
              type: 'text',
              text: 'Prima leggo la struttura del corso.',
              state: 'done',
            },
          ],
        } as UIMessage,
        {
          id: 'assistant-text-2',
          role: 'assistant',
          parts: [
            {
              type: 'text',
              text: 'Poi recupero i dettagli della lezione piu rilevante.',
              state: 'done',
            },
          ],
        } as UIMessage,
      ],
    };

    render(<HomeChatPanel {...props} />);

    expect(screen.getByText(/Prima leggo la struttura del corso\./i)).toBeInTheDocument();
    expect(
      screen.getByText(/Poi recupero i dettagli della lezione piu rilevante\./i)
    ).toBeInTheDocument();

    const assistantBubbles = screen.getAllByTestId('library-assistant-turn-bubble');
    expect(assistantBubbles).toHaveLength(1);
    expect(assistantBubbles[0]?.textContent).toContain('Prima leggo la struttura del corso.');
    expect(assistantBubbles[0]?.textContent).toContain(
      'Poi recupero i dettagli della lezione piu rilevante.'
    );
  });

  test('offers speech input in the library composer', () => {
    render(<HomeChatPanel {...buildProps()} homeChatMode="library-query" />);

    expect(screen.getByRole('button', { name: 'Avvia dettatura' })).toBeInTheDocument();
  });
  test('outside click closes the attachment menu', async () => {
    const user = userEvent.setup();
    const props = {
      ...buildProps(),
      homeChatMode: 'library-query' as const,
    };

    render(<HomeChatPanel {...props} />);

    // Open attachment menu
    await user.click(screen.getByTitle(/Apri esploratore contesto libreria/i));

    expect(screen.getByRole('menu')).toBeInTheDocument();

    // Click outside the menu (on the main section)
    await user.click(document.body);

    // Menu should be closed — no menu in document
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  test('click inside the attachment menu does not close it', async () => {
    const user = userEvent.setup();
    const props = {
      ...buildProps(),
      homeChatMode: 'library-query' as const,
    };

    render(<HomeChatPanel {...props} />);

    // Open attachment menu
    await user.click(screen.getByTitle(/Apri esploratore contesto libreria/i));

    expect(screen.getByRole('menu')).toBeInTheDocument();

    // Click on an item inside the menu
    await user.click(screen.getByText(/Scegli corsi o cartelle/i));

    // Menu should still be open
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });
});
