// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UIMessage } from 'ai';
import { useState } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import logoDarkModeUrl from '@/assets/logo_darkmode.svg';
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
  Object.defineProperty(globalThis, 'innerWidth', {
    configurable: true,
    value: width,
    writable: true,
  });
  globalThis.dispatchEvent(new Event('resize'));
};

const setViewportHeight = (height: number) => {
  Object.defineProperty(globalThis, 'innerHeight', {
    configurable: true,
    value: height,
    writable: true,
  });
  globalThis.dispatchEvent(new Event('resize'));
};

const createDomRect = (top: number, height: number): DOMRect =>
  ({
    bottom: top + height,
    height,
    left: 0,
    right: 40,
    top,
    width: 40,
    x: 0,
    y: top,
    toJSON: () => ({}),
  }) as DOMRect;

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
  onCancelNewCourse: vi.fn(),
  onConfirmGenerate: vi.fn(),
  onHomeChatModeChange: vi.fn(),
  onLibraryMessageSend: vi.fn(async () => {}),
  onLibraryWebSearchChange: vi.fn(),
  onLibraryGenerateArtifactsChange: vi.fn(),
  onSendAssessmentMessage: vi.fn(async () => {}),
  onToggleLibraryContextRef: vi.fn(),
  onUploadSourceClick: vi.fn(),
  pendingFileName: null,
});

describe('HomeChatPanel', () => {
  beforeEach(() => {
    HTMLElement.prototype.scrollIntoView = vi.fn();
    setViewportWidth(1280);
    setViewportHeight(800);
  });

  test('allocates the active mobile chat height from the visible viewport', async () => {
    setViewportWidth(390);
    const props = { ...buildProps(), assessmentMessages: [] };
    const { container, rerender } = render(
      <HomeChatPanel {...props} compactWhenEmpty hideHeaderCopy hideModeSelector />
    );
    const chat = container.querySelector('section');
    expect(chat).not.toHaveStyle({ height: '600px' });

    rerender(
      <HomeChatPanel
        {...props}
        assessmentMessages={[{ role: 'user', text: 'Inizia la conversazione' }]}
        compactWhenEmpty
        hideHeaderCopy
        hideModeSelector
      />
    );

    await waitFor(() => expect(chat).toHaveStyle({ height: '600px' }));
    expect(chat).toContainElement(screen.getByRole('textbox'));
  });

  test('removes the outer surface treatment only while the chat is compact', () => {
    setViewportWidth(1280);
    const props = { ...buildProps(), assessmentMessages: [] };
    const { container, rerender } = render(
      <HomeChatPanel {...props} compactWhenEmpty hideHeaderCopy hideModeSelector />
    );
    const chat = container.querySelector('section');
    const composer = chat?.lastElementChild;
    expect(chat).toHaveClass(
      'rounded-none',
      'bg-transparent',
      'shadow-none',
      'dark:bg-transparent',
      'dark:shadow-none'
    );
    expect(composer).toHaveClass('border-0', 'p-0');

    rerender(
      <HomeChatPanel
        {...props}
        assessmentMessages={[{ role: 'user', text: 'Inizia la conversazione' }]}
        compactWhenEmpty
        hideHeaderCopy
        hideModeSelector
      />
    );

    expect(chat).not.toHaveClass('rounded-none', 'bg-transparent');
    expect(composer).not.toHaveClass('border-0', 'p-0');
  });

  test('can cancel an active new-course interview from the trash action', async () => {
    const user = userEvent.setup();
    const props = buildProps();

    render(<HomeChatPanel {...props} compactWhenEmpty hideHeaderCopy hideModeSelector />);

    await user.click(
      screen.getByRole('button', { name: /Cancel course creation|Annulla creazione corso/i })
    );

    expect(props.onCancelNewCourse).toHaveBeenCalledOnce();
  });

  test('follows streaming growth inside the messages viewport without scrolling the page', () => {
    setViewportWidth(390);
    const props = buildProps();
    const { container, rerender } = render(<HomeChatPanel {...props} />);
    const messagesViewport = container.querySelector('.home-chat-scrollbar');
    if (!(messagesViewport instanceof HTMLDivElement)) {
      throw new Error('Expected the home chat scroll container.');
    }
    Object.defineProperty(messagesViewport, 'scrollHeight', {
      configurable: true,
      value: 720,
    });
    messagesViewport.scrollTop = 0;
    vi.mocked(HTMLElement.prototype.scrollIntoView).mockClear();

    rerender(
      <HomeChatPanel
        {...props}
        assessmentMessages={[
          {
            role: 'model',
            text: 'Messaggio assessment con nuovi token in streaming',
          },
        ]}
      />
    );

    expect(messagesViewport.scrollTop).toBe(720);
    expect(HTMLElement.prototype.scrollIntoView).not.toHaveBeenCalled();
  });

  test('shows only the latest two mobile tools and latest four desktop tools', async () => {
    setViewportWidth(390);
    const props = {
      ...buildProps(),
      homeChatMode: 'library-query' as const,
      libraryMessages: [
        {
          id: 'assistant-tools',
          role: 'assistant',
          parts: [
            {
              type: 'tool-listLibraryTree',
              toolCallId: 'tool-1',
              state: 'output-available',
              input: {},
              output: {},
            },
            {
              type: 'tool-getProjectStructures',
              toolCallId: 'tool-2',
              state: 'input-available',
              input: { projectIds: ['project-1'] },
            },
            {
              type: 'tool-searchLibrary',
              toolCallId: 'tool-3',
              state: 'input-available',
              input: { query: 'strumento ancora attivo' },
            },
            {
              type: 'tool-searchWeb',
              toolCallId: 'tool-4',
              state: 'output-available',
              input: { query: 'strumento completato più recente' },
              output: {},
            },
            {
              type: 'tool-getLessonDetails',
              toolCallId: 'tool-5',
              state: 'output-available',
              input: {},
              output: {},
            },
          ],
        } as UIMessage,
      ],
    };
    const { rerender } = render(<HomeChatPanel {...props} />);

    expect(screen.getByText('Dettagli lezioni')).toBeInTheDocument();
    expect(screen.getByText('Ricerca web')).toBeInTheDocument();
    expect(screen.queryByText('Ricerca contenuti')).not.toBeInTheDocument();
    expect(screen.queryByText('Struttura corsi')).not.toBeInTheDocument();
    expect(screen.getByText('…')).toBeInTheDocument();

    setViewportWidth(1280);
    rerender(<HomeChatPanel {...props} />);

    await waitFor(() => expect(screen.getByText('Ricerca contenuti')).toBeInTheDocument());
    expect(screen.getByText('Struttura corsi')).toBeInTheDocument();
    expect(screen.getByText('Ricerca web')).toBeInTheDocument();
    expect(screen.getByText('Dettagli lezioni')).toBeInTheDocument();
    expect(screen.queryByText('Indice libreria')).not.toBeInTheDocument();
  });

  test('reserves message space for the clear-chat overlay only while the header is hidden', async () => {
    setViewportWidth(390);
    const user = userEvent.setup();
    const onClearLibraryMessages = vi.fn();
    const { container, rerender } = render(
      <HomeChatPanel
        {...buildProps()}
        homeChatMode="library-query"
        hideHeaderCopy
        hideModeSelector
        onClearLibraryMessages={onClearLibraryMessages}
      />
    );

    const clearButton = screen.getByRole('button', { name: /Pulisci questa chat/i });
    const messagesViewport = container.querySelector('.home-chat-scrollbar');
    expect(screen.queryByTestId('home-chat-mode-copy')).not.toBeInTheDocument();
    expect(clearButton.parentElement).toBe(container.querySelector('section'));
    expect(messagesViewport).toHaveClass('pb-4', 'pt-16');
    expect(messagesViewport).not.toHaveClass('py-4');

    await user.click(clearButton);
    expect(onClearLibraryMessages).toHaveBeenCalledOnce();

    rerender(
      <HomeChatPanel
        {...buildProps()}
        homeChatMode="library-query"
        onClearLibraryMessages={onClearLibraryMessages}
      />
    );

    expect(screen.getByTestId('home-chat-mode-copy')).toBeInTheDocument();
    expect(messagesViewport).toHaveClass('py-4');
    expect(messagesViewport).not.toHaveClass('pt-16');
  });

  test('maps scroll progress to the actual overflow for short, medium, and long chats', () => {
    const props = buildProps();
    const { container, rerender } = render(<HomeChatPanel {...props} />);
    const scrollContainer = container.querySelector('.home-chat-scrollbar');
    expect(scrollContainer).not.toBeNull();
    if (!(scrollContainer instanceof HTMLDivElement)) {
      throw new Error('Expected the home chat scroll container.');
    }
    const messagesContent = scrollContainer.firstElementChild;
    if (!(messagesContent instanceof HTMLDivElement)) {
      throw new Error('Expected the home chat messages content.');
    }

    Object.defineProperties(scrollContainer, {
      clientHeight: { configurable: true, value: 200 },
      scrollHeight: { configurable: true, value: 440 },
    });
    rerender(<HomeChatPanel {...props} scrollProgressOverride={0.5} />);

    expect(scrollContainer.scrollTop).toBe(0);
    expect(messagesContent).toHaveStyle({ transform: 'translateY(-120px)' });

    Object.defineProperty(scrollContainer, 'scrollHeight', { configurable: true, value: 1200 });
    rerender(<HomeChatPanel {...props} scrollProgressOverride={1} />);
    expect(messagesContent).toHaveStyle({ transform: 'translateY(-1000px)' });

    Object.defineProperty(scrollContainer, 'scrollHeight', { configurable: true, value: 120 });
    rerender(<HomeChatPanel {...props} scrollProgressOverride={0.75} />);
    expect(messagesContent).toHaveStyle({ transform: 'translateY(-0px)' });
  });

  test('shows 49 numbered PDFs as distinct sources', () => {
    const numberedPdfNames = Array.from(
      { length: 49 },
      (_, index) => `${String(index + 1).padStart(index === 48 ? 3 : 2, '0')}.pdf`
    );
    render(
      <HomeChatPanel
        {...buildProps()}
        assessmentMessages={[]}
        pendingFileNames={numberedPdfNames}
      />
    );

    expect(screen.getByText(/49 (sources selected|fonti selezionate)/i)).toBeInTheDocument();
    expect(screen.getByText('01.pdf')).toBeInTheDocument();
    expect(screen.getByText('049.pdf')).toBeInTheDocument();
  });

  test('renders the course setup surface in the browser language', () => {
    Object.defineProperties(globalThis.navigator, {
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

  test('stops a streaming library response from the composer with the keyboard', async () => {
    const user = userEvent.setup();
    const stop = vi.fn();
    const onLibraryMessageSend = Object.assign(
      vi.fn(async () => {}),
      { stop }
    );
    const props = {
      ...buildProps(),
      homeChatMode: 'library-query' as const,
      isLibraryModeLoading: true,
      libraryMessages: [
        {
          id: 'assistant-streaming',
          role: 'assistant' as const,
          parts: [
            { type: 'text' as const, text: 'Risposta parziale', state: 'streaming' as const },
          ],
        },
      ],
      onLibraryMessageSend,
    };

    render(<HomeChatPanel {...props} />);

    const stopButton = screen.getByRole('button', { name: /^(Cancel|Annulla)$/i });
    stopButton.focus();
    await user.keyboard('{Enter}');
    await user.keyboard('{Enter}');

    expect(stop).toHaveBeenCalledOnce();
    expect(onLibraryMessageSend).not.toHaveBeenCalled();
    expect(stopButton).toBeDisabled();
    expect(stopButton).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByText('Risposta parziale')).toBeInTheDocument();
  });

  test('keeps submission locked while a library response has no Stop handler', () => {
    const props = {
      ...buildProps(),
      homeChatMode: 'library-query' as const,
      isLibraryModeLoading: true,
    };

    render(<HomeChatPanel {...props} />);

    const submitButton = screen.getByRole('button', { name: /Invia domanda libreria/i });
    expect(submitButton).toBeDisabled();
    expect(submitButton).toHaveAttribute('type', 'submit');
  });

  test('keeps the active Stop action visible by blocking mode changes during streaming', async () => {
    const user = userEvent.setup();
    const stop = vi.fn();
    const onLibraryMessageSend = Object.assign(
      vi.fn(async () => {}),
      { stop }
    );
    const props = {
      ...buildProps(),
      homeChatMode: 'library-query' as const,
      isLibraryModeLoading: true,
      onLibraryMessageSend,
    };

    render(<HomeChatPanel {...props} />);

    const newCourseTab = screen.getByRole('tab', { name: /Nuovo corso/i });
    expect(newCourseTab).toBeDisabled();
    expect(screen.getByTitle(/Apri esploratore contesto libreria/i)).toBeDisabled();
    await user.click(newCourseTab);
    expect(props.onHomeChatModeChange).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /^(Cancel|Annulla)$/i }));
    expect(stop).toHaveBeenCalledOnce();
  });

  test('uses the existing course cancellation for a generating new-course response', async () => {
    const user = userEvent.setup();
    const props = {
      ...buildProps(),
      isNewCourseLoading: true,
    };

    render(<HomeChatPanel {...props} />);

    await user.click(screen.getByRole('button', { name: /^(Cancel|Annulla)$/i }));

    expect(props.onCancelNewCourse).toHaveBeenCalledOnce();
    expect(props.onSendAssessmentMessage).not.toHaveBeenCalled();
  });

  test('re-enables Stop when new-course cancellation fails', async () => {
    const user = userEvent.setup();
    const onCancelNewCourse = vi.fn(async () => false);
    const props = buildProps();
    const { rerender } = render(
      <HomeChatPanel {...props} isNewCourseLoading onCancelNewCourse={onCancelNewCourse} />
    );

    const stopButton = screen.getByRole('button', { name: /^(Cancel|Annulla)$/i });
    await user.click(stopButton);

    expect(onCancelNewCourse).toHaveBeenCalledOnce();
    await waitFor(() => expect(stopButton).toBeEnabled());
    expect(stopButton).not.toHaveAttribute('aria-busy');

    await user.click(stopButton);
    expect(onCancelNewCourse).toHaveBeenCalledTimes(2);

    rerender(
      <HomeChatPanel {...props} isNewCourseLoading={false} onCancelNewCourse={onCancelNewCourse} />
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Start|Inizia/i })).toBeInTheDocument()
    );
  });

  test('keeps the composer locked while new-course cancellation is settling', async () => {
    const user = userEvent.setup();
    let finishCancellation: (succeeded: boolean) => void = () => {};
    const cancellation = new Promise<boolean>(resolve => {
      finishCancellation = resolve;
    });
    const props = buildProps();
    const onCancelNewCourse = vi.fn(() => cancellation);
    const { rerender } = render(
      <HomeChatPanel {...props} isNewCourseLoading onCancelNewCourse={onCancelNewCourse} />
    );

    await user.click(screen.getByRole('button', { name: /^(Cancel|Annulla)$/i }));
    rerender(
      <HomeChatPanel {...props} isNewCourseLoading={false} onCancelNewCourse={onCancelNewCourse} />
    );

    const stoppingButton = screen.getByRole('button', { name: /^(Cancel|Annulla)$/i });
    expect(stoppingButton).toBeDisabled();
    expect(stoppingButton).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('textbox')).toBeDisabled();

    finishCancellation(true);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Start|Inizia/i })).toBeDisabled()
    );
    expect(screen.getByRole('textbox')).toBeEnabled();
  });

  test('replaces the current draft and selects the editable course name', async () => {
    const user = userEvent.setup();
    const props = {
      ...buildProps(),
      assessmentMessages: [],
      homeChatMode: 'library-query' as const,
    };
    const { rerender } = render(<HomeChatPanel {...props} compactWhenEmpty />);
    const input = screen.getByRole('textbox') as HTMLInputElement;
    await user.type(input, 'Testo precedente da sostituire');

    rerender(
      <HomeChatPanel
        key="review-1"
        {...props}
        compactWhenEmpty
        draftTemplate={{
          id: 'review-1',
          mode: 'library-query',
          selection: { start: 29, end: 44 },
          value: 'Aiutami a ripassare il corso nome del corso, partendo dalle mie note.',
        }}
      />
    );

    await waitFor(() => {
      const templatedInput = screen.getByRole('textbox') as HTMLInputElement;
      expect(templatedInput).toHaveValue(
        'Aiutami a ripassare il corso nome del corso, partendo dalle mie note.'
      );
      expect(templatedInput.selectionStart).toBe(29);
      expect(templatedInput.selectionEnd).toBe(44);
    });
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

    expect(screen.getByText(/Contesto libreria/i)).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: /Corso TypeScript/i }));

    expect(props.onToggleLibraryContextRef).toHaveBeenCalledWith({
      id: 'project-1',
      kind: 'project',
      label: 'Corso TypeScript',
    });
  });

  test.each([
    390, 1280,
  ])('offers local source upload from the library attachment surface at %ipx', async viewportWidth => {
    setViewportWidth(viewportWidth);
    const user = userEvent.setup();
    const props = {
      ...buildProps(),
      homeChatMode: 'library-query' as const,
    };

    render(<HomeChatPanel {...props} />);

    await user.click(screen.getByTitle(/Apri esploratore contesto libreria/i));
    await user.click(screen.getByRole('button', { name: /Allega file per un nuovo corso/i }));

    expect(props.onUploadSourceClick).toHaveBeenCalledOnce();
  });

  test('round-trips folder selection through controlled state and updates the context badge', async () => {
    const user = userEvent.setup();

    const ControlledPanel = () => {
      const [attachedContextRefs, setAttachedContextRefs] = useState<LibraryContextRef[]>([]);

      return (
        <HomeChatPanel
          {...buildProps()}
          assessmentMessages={[]}
          homeChatMode="library-query"
          libraryAttachedContextRefs={attachedContextRefs}
          onToggleLibraryContextRef={reference =>
            setAttachedContextRefs(currentRefs =>
              currentRefs.some(
                currentRef => currentRef.id === reference.id && currentRef.kind === reference.kind
              )
                ? []
                : [reference]
            )
          }
        />
      );
    };

    render(<ControlledPanel />);

    const attachmentButton = screen.getByTitle(/Apri esploratore contesto libreria/i);
    await user.click(attachmentButton);
    const folderCheckbox = screen.getByRole('checkbox', { name: folder.name });

    await user.click(folderCheckbox);

    expect(folderCheckbox).toBeChecked();
    expect(attachmentButton).toHaveTextContent('1');

    await user.click(folderCheckbox);

    expect(folderCheckbox).not.toBeChecked();
    expect(attachmentButton).not.toHaveTextContent('1');
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
    expect(screen.getByText(/Contesto libreria/i)).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: /Nuovo corso/i }));
    expect(props.onHomeChatModeChange).toHaveBeenCalledWith('new-course');

    rerender(<HomeChatPanel {...props} homeChatMode="new-course" />);

    expect(screen.queryByText(/Contesto libreria/i)).not.toBeInTheDocument();
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

  test('counts enabled library tools on the plus button', () => {
    render(
      <HomeChatPanel
        {...buildProps()}
        homeChatMode="library-query"
        libraryGenerateArtifacts
        libraryWebSearch
      />
    );

    expect(screen.getByTitle(/Apri strumenti libreria/i)).toHaveTextContent('2');
  });

  test('selecting a folder selects its descendant courses and counts unique courses', async () => {
    const user = userEvent.setup();
    const props = {
      ...buildProps(),
      homeChatMode: 'library-query' as const,
      libraryAttachedContextRefs: [
        {
          id: folder.id,
          kind: 'folder' as const,
          label: folder.name,
        },
        {
          id: project.id,
          kind: 'project' as const,
          label: project.title,
        },
      ],
      libraryTree: {
        ...libraryTree,
        descendantProjectIdsByFolderId: {
          [folder.id]: [project.id, 'project-2'],
        },
      },
    };

    render(<HomeChatPanel {...props} />);

    expect(screen.getByTitle(/Apri esploratore contesto libreria/i)).toHaveTextContent('2');
    await user.click(screen.getByTitle(/Apri esploratore contesto libreria/i));
    expect(screen.getByRole('checkbox', { name: /Corso TypeScript/i })).toBeChecked();
  });

  test('opens the desktop tools menu below the composer when it would clip above', async () => {
    const user = userEvent.setup();
    Object.defineProperty(globalThis, 'innerHeight', {
      configurable: true,
      value: 700,
      writable: true,
    });
    const rectSpy = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockImplementation(function (this: HTMLElement) {
        if (this.getAttribute('role') === 'menu') {
          return createDomRect(0, 260);
        }
        if (this.getAttribute('title')?.match(/Apri strumenti libreria/i)) {
          return createDomRect(180, 40);
        }
        return createDomRect(0, 0);
      });

    render(<HomeChatPanel {...buildProps()} homeChatMode="library-query" />);
    await user.click(screen.getByTitle(/Apri strumenti libreria/i));

    expect(screen.getByRole('menu')).toHaveClass('top-[calc(100%+0.75rem)]');
    expect(screen.getByRole('menu')).not.toHaveClass('bottom-[calc(100%+0.75rem)]');
    rectSpy.mockRestore();
  });

  test('does not reserve empty composer space in library mode without context chips', () => {
    const props = {
      ...buildProps(),
      homeChatMode: 'library-query' as const,
    };

    render(<HomeChatPanel {...props} />);

    expect(screen.queryByTestId('library-chat-context-bar')).not.toBeInTheDocument();
  });

  test('does not shift the composer when web search is active', () => {
    const props = {
      ...buildProps(),
      homeChatMode: 'library-query' as const,
      libraryWebSearch: true,
    };

    render(<HomeChatPanel {...props} />);

    expect(screen.queryByTestId('library-chat-context-bar')).not.toBeInTheDocument();
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
    const onLibraryArtifactDiscard = vi.fn();
    const onLibraryArtifactRegenerate = vi.fn();
    const props = {
      ...buildProps(),
      homeChatMode: 'library-query' as const,
      onLibraryArtifactDiscard,
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
    expect(screen.queryByRole('button', { name: /Scarta artefatto/i })).not.toBeInTheDocument();
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
    expect(onLibraryArtifactDiscard).not.toHaveBeenCalled();
  });

  test('uses the light owl asset for assistant avatars in dark mode', () => {
    render(
      <HomeChatPanel {...buildProps()} homeChatMode="library-query" isDarkMode showChatAvatars />
    );

    expect(screen.getByRole('img', { name: /Assistente Nous/i })).toHaveAttribute(
      'src',
      logoDarkModeUrl
    );
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

    // Select context inside the menu
    await user.click(screen.getByRole('checkbox', { name: /Corso TypeScript/i }));

    // Menu should still be open
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });
});
