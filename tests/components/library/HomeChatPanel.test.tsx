// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UIMessage } from 'ai';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import HomeChatPanel from '../../../components/library/HomeChatPanel.tsx';
import type {
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
  scopeSummary: 'Intera libreria locale (1 corsi disponibili).',
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
  libraryScopeSummary,
  libraryTree,
  libraryWebSearch: false,
  newCourseLoadingStatus: 'Caricamento...',
  onClearPendingFile: vi.fn(),
  onConfirmGenerate: vi.fn(),
  onHomeChatModeChange: vi.fn(),
  onLibraryMessageSend: vi.fn(async () => {}),
  onLibraryWebSearchChange: vi.fn(),
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
      screen.getByPlaceholderText(/Descrivi l obiettivo del corso o allega un file/i),
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

    const { container } = render(<HomeChatPanel {...props} />);

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
});
