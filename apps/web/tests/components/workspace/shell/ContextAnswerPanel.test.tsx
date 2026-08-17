// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef, type ReactNode, StrictMode } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { ContextAnswerState } from '../../../../components/workspace/shell/types.ts';

import type { LearningArtifactRenderPayload, ProjectSnapshot } from '../../../../types.ts';
import {
  buildTestLearningPlan,
  buildTestLesson,
  buildTestProjectMeta,
} from '../../../helpers/learningPlan.ts';

const defaultChatTransportInstances: Array<{
  prepareSendMessagesRequest?: (args: unknown) => unknown;
}> = [];
const sendMessageMock = vi.fn();
const addToolOutputMock = vi.fn();
const useChatMock = vi.fn();
const lastAssistantMessageIsCompleteWithToolCallsMock = vi.fn<
  (options: { messages: Array<{ parts: Array<{ type: string }> }> }) => boolean
>(() => false);
const generateLessonArtifactDraftMock = vi.fn();
const useMobileKeyboardOffsetMock = vi.fn();
const chatTextComposerProps: Array<{
  disabled?: boolean;
  inputDataTarget?: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  placeholder: string;
  trailingContent?: ReactNode;
  value: string;
}> = [];

vi.mock('@ai-sdk/react', () => ({
  useChat: useChatMock,
}));

vi.mock('ai', () => ({
  DefaultChatTransport: class DefaultChatTransport {
    prepareSendMessagesRequest?: (args: unknown) => unknown;

    constructor(config: { prepareSendMessagesRequest?: (args: unknown) => unknown }) {
      this.prepareSendMessagesRequest = config.prepareSendMessagesRequest;
      defaultChatTransportInstances.push(this);
    }
  },
  isTextUIPart: (part: { type?: string }) => part?.type === 'text',
  isToolUIPart: (part: { type?: string }) =>
    typeof part?.type === 'string' && part.type.startsWith('tool-'),
  lastAssistantMessageIsCompleteWithToolCalls: lastAssistantMessageIsCompleteWithToolCallsMock,
}));

vi.mock('../../../../components/shared/MarkdownRenderer.tsx', () => ({
  default: ({ content }: { content: string }) => (
    <div data-testid="markdown-renderer">{content}</div>
  ),
}));

vi.mock('../../../../components/workspace/chat/ChatTextComposer.tsx', () => ({
  default: (props: {
    disabled?: boolean;
    inputDataTarget?: string;
    onChange: (value: string) => void;
    onSubmit: () => void;
    placeholder: string;
    trailingContent?: ReactNode;
    value: string;
  }) => {
    chatTextComposerProps.push(props);
    return (
      <>
        {props.trailingContent}
        <input
          data-chat-composer-target={props.inputDataTarget}
          value={props.value}
          onChange={event => props.onChange(event.target.value)}
        />
        <button
          type="button"
          data-testid="chat-text-composer"
          disabled={props.disabled}
          onClick={props.onSubmit}
        >
          {props.placeholder}
        </button>
      </>
    );
  },
}));

vi.mock('../../../../services/openrouter/config.ts', () => ({
  getBackendUrl: () => 'http://localhost:3301',
}));

vi.mock('../../../../services/auth/supabaseAuth.ts', () => ({
  fetchWithSupabaseAuth: vi.fn(),
}));

vi.mock('../../../../services/openrouter/artifactDrafts.ts', () => ({
  generateLessonArtifactDraft: generateLessonArtifactDraftMock,
}));

vi.mock('../../../../hooks/useMobileKeyboardOffset.ts', () => ({
  useMobileKeyboardOffset: useMobileKeyboardOffsetMock,
}));

const { default: ContextAnswerPanel } = await import(
  '../../../../components/workspace/shell/ContextAnswerPanel.tsx'
);

const currentLessonArtifact = {
  summary: {
    id: 'project-1:lesson-1:generated-visual:visual-1',
    kind: 'generated-visual',
    lessonId: 'lesson-1',
    lessonTitle: 'Titolo',
    previewMode: 'thumbnail',
    projectId: 'project-1',
    projectTitle: 'Corso',
    title: 'mappa concettuale',
  },
  visual: {
    id: 'visual-1',
    title: 'mappa_concettuale',
    kind: 'svg',
    code: '<svg viewBox="0 0 680 120"></svg>',
    createdAt: '2026-05-01T10:00:00.000Z',
  },
} as const;

const crossCourseArtifact = {
  summary: {
    id: 'project-2:lesson-2:generated-visual:visual-foreign',
    kind: 'generated-visual',
    lessonId: 'lesson-2',
    lessonTitle: 'Routing',
    previewMode: 'thumbnail',
    projectId: 'project-2',
    projectTitle: 'Reti',
    title: 'diagramma di routing',
  },
  visual: {
    id: 'visual-foreign',
    title: 'diagramma_di_routing',
    kind: 'svg',
    code: '<svg viewBox="0 0 680 120"></svg>',
    createdAt: '2026-05-02T10:00:00.000Z',
  },
} as const;

const otherLessonPdfArtifact: LearningArtifactRenderPayload = {
  image: {
    caption: 'Schema routing',
    dataUrl: 'data:image/png;base64,abc',
    id: 'pdf-image-other-lesson',
    mimeType: 'image/png',
    sourceOrder: 1,
    textAfter: '',
    textBefore: '',
  },
  summary: {
    id: 'project-1:lesson-2:pdf-image:pdf-image-other-lesson',
    kind: 'pdf-image',
    lessonId: 'lesson-2',
    lessonTitle: 'Altra lezione',
    previewMode: 'thumbnail',
    projectId: 'project-1',
    projectTitle: 'Corso',
    title: 'Schema routing',
  },
};

const crossCourseSnapshot: ProjectSnapshot = {
  id: 'project-2',
  version: '1',
  sourceKind: 'document',
  state: 'READING',
  source: null,
  learningPlan: buildTestLearningPlan([
    buildTestLesson({
      generatedVisuals: [crossCourseArtifact.visual],
      id: 'lesson-2',
      title: 'Routing',
    }),
  ]),
  isLearnMode: false,
  userProfile: null,
  syllabus: [],
  activeSectionId: 'lesson-2',
  createdAt: '2026-05-02T10:00:00.000Z',
  updatedAt: '2026-05-02T10:00:00.000Z',
  lastOpenedAt: '2026-05-02T10:00:00.000Z',
};

const replacementDraftArtifact = {
  summary: {
    ...currentLessonArtifact.summary,
    id: 'project-1:lesson-1:generated-visual:visual-2',
    replacementOfArtifactId: currentLessonArtifact.summary.id,
    title: 'mappa concettuale rivista',
  },
  visual: {
    ...currentLessonArtifact.visual,
    createdAt: '2026-05-01T11:00:00.000Z',
    id: 'visual-2',
    title: 'mappa_concettuale_rivista',
  },
} as const;

const generatedDraftArtifact = {
  summary: {
    ...currentLessonArtifact.summary,
    id: 'project-1:lesson-1:generated-visual:visual-new',
    title: 'schema nuovo',
  },
  visual: {
    ...currentLessonArtifact.visual,
    createdAt: '2026-05-01T12:00:00.000Z',
    id: 'visual-new',
    title: 'schema_nuovo',
  },
} as const;

const buildProps = (contextAnswerOverrides: Partial<ContextAnswerState> = {}) => ({
  contextAnswer: {
    id: 'context-1',
    initialQuestion: 'spiega meglio',
    selectedText: 'G-buffer',
    lessonContent: 'Contenuto',
    lessonDescription: 'Descrizione',
    lessonId: 'lesson-1',
    lessonTitle: 'Titolo',
    projectId: 'project-1',
    projectTitle: 'Corso',
    ...contextAnswerOverrides,
  },
  contextAnswerPanelRef: createRef<HTMLDivElement>(),
  contextAnswerSize: { width: 360, height: 280 },
  handleContextAnswerResizeStart: vi.fn(),
  isDarkMode: false,
  isMobileViewport: false,
  libraryAssistantDataSource: {
    attachedContextRefs: [],
    folders: [],
    loadProjectsById: vi.fn(async () => []),
    projects: [],
    tree: {
      descendantProjectIdsByFolderId: {},
      folderById: {},
      placementByProjectId: {},
      rootNodes: [],
    },
  },
  onClose: vi.fn(),
  onOpenLibraryReference: vi.fn(),
  onSaveConversationNote: vi.fn(),
  onUpdateConversationNote: vi.fn(),
  currentLessonArtifactPayloads: [currentLessonArtifact],
});

describe('ContextAnswerPanel', () => {
  beforeEach(() => {
    defaultChatTransportInstances.length = 0;
    sendMessageMock.mockReset();
    addToolOutputMock.mockReset();
    useChatMock.mockReset();
    lastAssistantMessageIsCompleteWithToolCallsMock.mockReset();
    lastAssistantMessageIsCompleteWithToolCallsMock.mockReturnValue(false);
    generateLessonArtifactDraftMock.mockReset();
    useMobileKeyboardOffsetMock.mockReset();
    useMobileKeyboardOffsetMock.mockReturnValue({ keyboardOffset: 0, viewportHeight: 768 });
    chatTextComposerProps.length = 0;
  });

  test('renders the mobile follow-up as a full-width bottom sheet that shrinks above the keyboard', () => {
    useMobileKeyboardOffsetMock.mockReturnValue({ keyboardOffset: 240, viewportHeight: 528 });
    useChatMock.mockReturnValue({
      addToolOutput: addToolOutputMock,
      error: undefined,
      messages: [],
      sendMessage: sendMessageMock,
      status: 'ready',
    });

    const { container } = render(<ContextAnswerPanel {...buildProps()} isMobileViewport={true} />);

    const panel = container.querySelector<HTMLElement>('[data-context-answer-panel="true"]');
    expect(panel).not.toBeNull();
    expect(panel).toHaveClass(
      'inset-x-0',
      'h-[80dvh]',
      'rounded-t-[2rem]',
      'rounded-b-none',
      'border-x-0',
      'border-b-0'
    );
    expect(panel).not.toHaveClass('inset-x-3', 'top-24', 'rounded-2xl');
    expect(panel?.style.bottom).toBe('240px');
    expect(panel?.style.height).toBe('');
    expect(panel?.style.maxHeight).toBe('528px');
    expect(screen.getByRole('button', { name: 'Chiudi' })).toHaveClass('right-4', 'top-4');
    expect(screen.queryByRole('button', { name: 'Ridimensiona pannello risposta' })).toBeNull();
  });

  test('dismisses the mobile keyboard on follow-up submit so streaming can use the 80% sheet', async () => {
    const user = userEvent.setup();
    useMobileKeyboardOffsetMock.mockReturnValue({ keyboardOffset: 240, viewportHeight: 528 });
    useChatMock.mockReturnValue({
      addToolOutput: addToolOutputMock,
      error: undefined,
      messages: [
        {
          id: 'assistant-1',
          role: 'assistant',
          parts: [{ type: 'text', text: 'Risposta iniziale', state: 'done' }],
        },
      ],
      sendMessage: sendMessageMock,
      status: 'ready',
    });

    const { container, rerender } = render(
      <ContextAnswerPanel {...buildProps()} isMobileViewport={true} />
    );
    const input = screen.getByRole('textbox');
    await user.type(input, 'Un esempio breve');
    expect(input).toHaveFocus();

    act(() => chatTextComposerProps.at(-1)?.onSubmit());

    expect(input).not.toHaveFocus();
    expect(sendMessageMock).toHaveBeenLastCalledWith({ text: 'Un esempio breve' });

    useMobileKeyboardOffsetMock.mockReturnValue({ keyboardOffset: 0, viewportHeight: 844 });
    useChatMock.mockReturnValue({
      addToolOutput: addToolOutputMock,
      error: undefined,
      messages: [
        {
          id: 'assistant-2',
          role: 'assistant',
          parts: [{ type: 'text', text: 'Risposta in streaming', state: 'streaming' }],
        },
      ],
      sendMessage: sendMessageMock,
      status: 'streaming',
    });
    rerender(<ContextAnswerPanel {...buildProps()} isMobileViewport={true} />);

    const panel = container.querySelector<HTMLElement>('[data-context-answer-panel="true"]');
    expect(panel).toHaveClass('h-[80dvh]');
    expect(panel?.style.bottom).toBe('0px');
    expect(panel?.style.maxHeight).toBe('844px');
    expect(screen.getByText('Risposta in streaming')).toBeInTheDocument();
  });

  test('preserves the desktop panel placement, size, and resize handle', () => {
    useChatMock.mockReturnValue({
      addToolOutput: addToolOutputMock,
      error: undefined,
      messages: [],
      sendMessage: sendMessageMock,
      status: 'ready',
    });

    const { container } = render(<ContextAnswerPanel {...buildProps()} />);

    const panel = container.querySelector<HTMLElement>('[data-context-answer-panel="true"]');
    expect(panel).not.toBeNull();
    expect(panel).toHaveClass('right-8', 'top-6', 'rounded-2xl', 'slide-in-from-bottom-10');
    expect(panel).not.toHaveClass('inset-x-0', 'rounded-b-none');
    expect(panel?.style.width).toBe('360px');
    expect(panel?.style.height).toBe('280px');
    expect(
      screen.getByRole('button', { name: 'Ridimensiona pannello risposta' })
    ).toBeInTheDocument();
  });

  test('auto-submits the initial question only once under StrictMode', () => {
    useChatMock.mockReturnValue({
      addToolOutput: addToolOutputMock,
      error: undefined,
      messages: [],
      sendMessage: sendMessageMock,
      status: 'ready',
    });

    render(
      <StrictMode>
        <ContextAnswerPanel {...buildProps({ id: 'context-strict-mode' })} />
      </StrictMode>
    );

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock).toHaveBeenCalledWith({ text: 'spiega meglio' });
  });

  test('renders streaming assistant text through the markdown renderer during streaming', () => {
    useChatMock.mockReturnValue({
      addToolOutput: addToolOutputMock,
      error: undefined,
      messages: [
        {
          id: 'user-1',
          role: 'user',
          parts: [{ type: 'text', text: 'spiega meglio', state: 'done' }],
        },
        {
          id: 'assistant-1',
          role: 'assistant',
          parts: [{ type: 'text', text: 'Risposta in corso', state: 'streaming' }],
        },
      ],
      sendMessage: sendMessageMock,
      status: 'streaming',
    });

    render(<ContextAnswerPanel {...buildProps()} />);

    expect(screen.getByText('Risposta in corso')).toBeInTheDocument();
    expect(screen.getByTestId('markdown-renderer')).toBeInTheDocument();
  });

  test('keeps the panel open and shows a stable error when a request fails', () => {
    useChatMock.mockReturnValue({
      addToolOutput: addToolOutputMock,
      error: new Error('Sensitive backend failure'),
      messages: [],
      sendMessage: sendMessageMock,
      status: 'ready',
    });

    const { container } = render(<ContextAnswerPanel {...buildProps()} />);

    expect(container.querySelector('[data-context-answer-panel="true"]')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Non è stato possibile ottenere una risposta. Riprova tra poco.'
    );
    expect(screen.queryByText('Sensitive backend failure')).toBeNull();
  });

  test('keeps assistant text after the note tool below the note card', () => {
    useChatMock.mockReturnValue({
      addToolOutput: addToolOutputMock,
      error: undefined,
      messages: [
        {
          id: 'assistant-1',
          role: 'assistant',
          parts: [
            { type: 'text', text: 'Prima della nota.', state: 'done' },
            {
              type: 'tool-requestAddToNotes',
              toolCallId: 'tool-1',
              state: 'input-available',
              input: {
                noteDraft: 'Nota finale',
                rationale: 'Vale la pena salvarla.',
                selectedTextDraft: 'G-buffer',
              },
            },
            { type: 'text', text: 'Dopo la nota.', state: 'done' },
          ],
        },
      ],
      sendMessage: sendMessageMock,
      status: 'ready',
    });

    const { container } = render(<ContextAnswerPanel {...buildProps()} />);

    const markdownBlocks = screen.getAllByTestId('markdown-renderer');
    const primaBlock = markdownBlocks.find(b => b.textContent?.includes('Prima della nota.'));
    const dopoBlock = markdownBlocks.find(b => b.textContent?.includes('Dopo la nota.'));
    expect(primaBlock).toBeTruthy();
    expect(dopoBlock).toBeTruthy();

    const renderedText = container.textContent || '';
    expect(renderedText.indexOf('Prima della nota.')).toBeLessThan(
      renderedText.indexOf('Vuoi aggiungerlo alle note?')
    );
    expect(renderedText.indexOf('Vuoi aggiungerlo alle note?')).toBeLessThan(
      renderedText.indexOf('Dopo la nota.')
    );
  });

  test('blocks the follow-up composer while requestAddToNotes awaits a decision', () => {
    useChatMock.mockReturnValue({
      addToolOutput: addToolOutputMock,
      error: undefined,
      messages: [
        {
          id: 'assistant-1',
          role: 'assistant',
          parts: [
            {
              type: 'tool-requestAddToNotes',
              toolCallId: 'tool-1',
              state: 'input-available',
              input: {
                noteDraft: 'Nota finale',
                rationale: 'Vale la pena salvarla.',
                selectedTextDraft: 'G-buffer',
              },
            },
          ],
        },
      ],
      sendMessage: sendMessageMock,
      status: 'ready',
    });

    render(<ContextAnswerPanel {...buildProps()} />);

    expect(screen.getByTestId('chat-text-composer')).toBeDisabled();
    expect(chatTextComposerProps.at(-1)?.disabled).toBe(true);
    expect(chatTextComposerProps.at(-1)?.placeholder).toMatch(/Accetta o rifiuta la nota/i);
  });

  test('offers speech input in the follow-up composer', () => {
    useChatMock.mockReturnValue({
      addToolOutput: addToolOutputMock,
      error: undefined,
      messages: [],
      sendMessage: sendMessageMock,
      status: 'ready',
    });

    render(<ContextAnswerPanel {...buildProps()} />);

    expect(screen.getByRole('button', { name: 'Avvia dettatura' })).toBeInTheDocument();
  });

  test('does not send a frontend model override with context chat requests', () => {
    useChatMock.mockReturnValue({
      addToolOutput: addToolOutputMock,
      error: undefined,
      messages: [],
      sendMessage: sendMessageMock,
      status: 'ready',
    });

    render(<ContextAnswerPanel {...buildProps()} />);

    const transport = defaultChatTransportInstances[0];
    expect(transport?.prepareSendMessagesRequest).toBeTypeOf('function');

    const request = transport?.prepareSendMessagesRequest?.({
      headers: { 'X-Existing-Header': 'kept' },
      id: 'chat-1',
      messages: [{ role: 'user', parts: [{ type: 'text', text: 'spiega meglio' }] }],
    }) as { body?: Record<string, unknown>; headers?: Record<string, string> };

    expect(request.body?.modelOverride).toBeUndefined();
    expect(request.headers).toEqual({ 'X-Existing-Header': 'kept' });
  });

  test('keeps lesson sources out of the follow-up header and sends provenance without file contents', () => {
    useChatMock.mockReturnValue({
      addToolOutput: addToolOutputMock,
      error: undefined,
      messages: [],
      sendMessage: sendMessageMock,
      status: 'ready',
    });
    const documentSourceReferences: NonNullable<ContextAnswerState['documentSourceReferences']> = [
      {
        chunkIds: ['source-01:chunk-a'],
        file: {
          data: 'PDF-DATA-MUST-NOT-BE-SENT',
          mimeType: 'application/pdf',
          name: '01.pdf',
          sourceId: 'source-01',
        },
        kind: 'pdf',
        name: '01.pdf',
        pageStart: 2,
        sourceId: 'source-01',
      },
      {
        chunkIds: ['source-049:chunk-final'],
        file: {
          data: 'FINAL-PDF-DATA-MUST-NOT-BE-SENT',
          mimeType: 'application/pdf',
          name: '049.pdf',
          sourceId: 'source-049',
        },
        kind: 'pdf',
        name: '049.pdf',
        pageEnd: 12,
        pageStart: 11,
        sourceId: 'source-049',
      },
    ];

    render(<ContextAnswerPanel {...buildProps({ documentSourceReferences })} />);

    expect(screen.queryByText(/2 (sources|fonti)/i)).not.toBeInTheDocument();
    expect(screen.queryByTitle('01.pdf, 049.pdf')).not.toBeInTheDocument();

    const request = defaultChatTransportInstances[0]?.prepareSendMessagesRequest?.({
      id: 'chat-sources',
      messages: [{ role: 'user', parts: [{ type: 'text', text: 'cita la fonte finale' }] }],
    }) as { body?: Record<string, unknown> };

    expect(request.body?.sourceReferences).toEqual([
      {
        chunkIds: ['source-01:chunk-a'],
        name: '01.pdf',
        pageEnd: undefined,
        pageStart: 2,
        sourceId: 'source-01',
      },
      {
        chunkIds: ['source-049:chunk-final'],
        name: '049.pdf',
        pageEnd: 12,
        pageStart: 11,
        sourceId: 'source-049',
      },
    ]);
    expect(request.body?.sourceName).toBe('2 fonti originali: 01.pdf | 049.pdf');
    expect(request.body).toMatchObject({
      projectId: 'project-1',
      projectTitle: 'Corso',
    });
    expect(JSON.stringify(request.body)).not.toContain('PDF-DATA-MUST-NOT-BE-SENT');
  });

  test('sends retained archive identity, version, and lesson selectors without archive bytes', () => {
    useChatMock.mockReturnValue({
      addToolOutput: addToolOutputMock,
      error: undefined,
      messages: [],
      sendMessage: sendMessageMock,
      status: 'ready',
    });
    const archiveVersion = {
      representationHash: 'b'.repeat(64),
      sourceHash: 'a'.repeat(64),
      sourceId: 'source-archive',
    };

    render(
      <ContextAnswerPanel
        {...buildProps({
          documentSourceReferences: [
            {
              archiveSelectors: [{ kind: 'file', path: 'src/client.cpp' }],
              archiveVersion,
              chunkIds: [],
              file: {
                data: 'ARCHIVE-BYTES-MUST-NOT-BE-SENT',
                mimeType: 'application/zip',
                name: 'src.zip',
                sourceId: 'source-archive',
              },
              kind: 'archive',
              name: 'src.zip',
              sourceId: 'source-archive',
            },
          ],
          sourceKind: 'archive',
        })}
      />
    );

    const request = defaultChatTransportInstances[0]?.prepareSendMessagesRequest?.({
      id: 'chat-archive',
      messages: [{ role: 'user', parts: [{ type: 'text', text: 'trova ClientMap' }] }],
    }) as { body?: Record<string, unknown> };

    expect(request.body?.sourceReferences).toEqual([
      {
        archiveSelectors: [{ kind: 'file', path: 'src/client.cpp' }],
        archiveVersion,
        chunkIds: [],
        name: 'src.zip',
        pageEnd: undefined,
        pageStart: undefined,
        sourceId: 'source-archive',
      },
    ]);
    expect(JSON.stringify(request.body)).not.toContain('ARCHIVE-BYTES-MUST-NOT-BE-SENT');
  });

  test('makes request context available synchronously when the chat session initializes', () => {
    let preparedBody: Record<string, unknown> | undefined;
    useChatMock.mockImplementation(
      ({
        transport,
      }: {
        transport: { prepareSendMessagesRequest: (args: unknown) => unknown };
      }) => {
        const request = transport.prepareSendMessagesRequest({
          id: 'chat-immediate',
          messages: [{ role: 'user', parts: [{ type: 'text', text: 'spiega meglio' }] }],
        }) as { body?: Record<string, unknown> };
        preparedBody = request.body;
        return {
          addToolOutput: addToolOutputMock,
          error: undefined,
          messages: [],
          sendMessage: sendMessageMock,
          status: 'ready',
        };
      }
    );

    render(<ContextAnswerPanel {...buildProps()} />);

    expect(preparedBody?.selectedText).toBe('G-buffer');
    expect(preparedBody?.lessonContent).toBe('Contenuto');
  });

  test('sends lesson context scope with context chat requests', () => {
    useChatMock.mockReturnValue({
      addToolOutput: addToolOutputMock,
      error: undefined,
      messages: [],
      sendMessage: sendMessageMock,
      status: 'ready',
    });

    render(
      <ContextAnswerPanel
        {...buildProps({
          contextScope: 'lesson',
          selectedText: 'Intera lezione: Titolo',
        })}
      />
    );

    const request = defaultChatTransportInstances[0]?.prepareSendMessagesRequest?.({
      id: 'chat-lesson',
      messages: [{ role: 'user', parts: [{ type: 'text', text: 'spiega tutto' }] }],
    }) as { body?: Record<string, unknown> };

    expect(request.body?.contextScope).toBe('lesson');
    expect(request.body?.selectedText).toBe('Intera lezione: Titolo');
  });

  test('renders current lesson artifact cards from tool results', () => {
    useChatMock.mockReturnValue({
      addToolOutput: addToolOutputMock,
      error: undefined,
      messages: [
        {
          id: 'assistant-artifacts',
          role: 'assistant',
          parts: [
            {
              type: 'tool-getCurrentLessonArtifacts',
              toolCallId: 'tool-artifacts-1',
              state: 'output-available',
              input: {},
              output: {
                artifactCount: 1,
                artifacts: [currentLessonArtifact.summary],
                renderMode: 'attachments',
                renderedArtifactCount: 1,
              },
            },
          ],
        },
      ],
      sendMessage: sendMessageMock,
      status: 'ready',
    });

    render(<ContextAnswerPanel {...buildProps()} />);

    expect(screen.getByText('mappa concettuale')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Apri mappa concettuale/i })).toBeInTheDocument();
  });

  test('keeps current-lesson artifact tools bound to the retained answer origin', async () => {
    let onToolCall:
      | ((args: {
          toolCall: {
            dynamic: false;
            input: Record<string, never>;
            toolCallId: string;
            toolName: 'getCurrentLessonArtifacts';
          };
        }) => Promise<void>)
      | undefined;
    useChatMock.mockImplementation(options => {
      onToolCall = options.onToolCall;
      return {
        addToolOutput: addToolOutputMock,
        error: undefined,
        messages: [],
        sendMessage: sendMessageMock,
        status: 'ready',
      };
    });
    const props = buildProps({ id: 'context-retained-origin-artifacts' });
    const { rerender } = render(<ContextAnswerPanel {...props} />);

    rerender(
      <ContextAnswerPanel {...props} currentLessonArtifactPayloads={[otherLessonPdfArtifact]} />
    );
    await act(async () => {
      await onToolCall?.({
        toolCall: {
          dynamic: false,
          input: {},
          toolCallId: 'tool-origin-artifacts',
          toolName: 'getCurrentLessonArtifacts',
        },
      });
    });

    expect(addToolOutputMock).toHaveBeenCalledWith(
      expect.objectContaining({
        output: expect.objectContaining({
          artifacts: [currentLessonArtifact.summary],
        }),
      })
    );
  });

  test('includes a newly saved artifact in later origin-lesson tool results', async () => {
    const user = userEvent.setup();
    let onToolCall:
      | ((args: {
          toolCall: {
            dynamic: false;
            input: Record<string, unknown>;
            toolCallId: string;
            toolName: 'generateCurrentLessonArtifact' | 'getCurrentLessonArtifacts';
          };
        }) => Promise<void>)
      | undefined;
    generateLessonArtifactDraftMock.mockResolvedValue({
      artifactId: generatedDraftArtifact.summary.id,
      payload: generatedDraftArtifact,
      visual: generatedDraftArtifact.visual,
    });
    useChatMock.mockImplementation(options => {
      onToolCall = options.onToolCall;
      return {
        addToolOutput: addToolOutputMock,
        error: undefined,
        messages: [
          {
            id: 'assistant-generated-artifact',
            role: 'assistant',
            parts: [
              {
                type: 'tool-generateCurrentLessonArtifact',
                toolCallId: 'tool-generate-artifact',
                state: 'output-available',
                input: { prompt: 'Crea uno schema.' },
                output: {
                  artifact: generatedDraftArtifact.summary,
                  artifactId: generatedDraftArtifact.summary.id,
                  renderedArtifactCount: 1,
                },
              },
            ],
          },
        ],
        sendMessage: sendMessageMock,
        status: 'ready',
      };
    });
    const onSaveArtifactToLesson = vi.fn(async () => ({ succeeded: true }));
    render(
      <ContextAnswerPanel
        {...buildProps({ id: 'context-saved-origin-artifact' })}
        onSaveArtifactToLesson={onSaveArtifactToLesson}
      />
    );

    await act(async () => {
      await onToolCall?.({
        toolCall: {
          dynamic: false,
          input: { prompt: 'Crea uno schema.' },
          toolCallId: 'tool-generate-artifact',
          toolName: 'generateCurrentLessonArtifact',
        },
      });
    });
    await user.click(await screen.findByRole('button', { name: /Apri schema nuovo/i }));
    await user.click(screen.getByRole('button', { name: /Salva artefatto nella lezione/i }));

    addToolOutputMock.mockClear();
    await act(async () => {
      await onToolCall?.({
        toolCall: {
          dynamic: false,
          input: {},
          toolCallId: 'tool-saved-origin-artifacts',
          toolName: 'getCurrentLessonArtifacts',
        },
      });
    });

    expect(addToolOutputMock).toHaveBeenCalledWith(
      expect.objectContaining({
        toolCallId: 'tool-saved-origin-artifacts',
        output: expect.objectContaining({
          artifacts: [currentLessonArtifact.summary, generatedDraftArtifact.summary],
        }),
      })
    );
  });

  test('renders cross-course artifact attachments returned by the shared library executor', async () => {
    const user = userEvent.setup();
    const onSaveConversationNote = vi.fn(async () => ({
      annotationId: 'annotation-cross-course',
      merged: false,
      saved: true,
    }));
    useChatMock.mockReturnValue({
      addToolOutput: addToolOutputMock,
      error: undefined,
      messages: [],
      sendMessage: sendMessageMock,
      status: 'ready',
    });
    const baseProps = buildProps({ id: 'context-library-artifacts' });
    const props = {
      ...baseProps,
      libraryAssistantDataSource: {
        ...baseProps.libraryAssistantDataSource,
        loadProjectsById: vi.fn(async () => [crossCourseSnapshot]),
        projects: [
          buildTestProjectMeta({
            id: 'project-2',
            title: 'Reti',
            lessonCount: 1,
          }),
        ],
      },
      onSaveConversationNote,
    };

    const { rerender } = render(<ContextAnswerPanel {...props} />);
    const chatOptions = useChatMock.mock.calls.at(-1)?.[0] as {
      onToolCall: (args: {
        toolCall: {
          dynamic: false;
          input: { projectIds: string[]; renderMode: 'attachments' };
          toolCallId: string;
          toolName: 'getLearningArtifacts';
        };
      }) => Promise<void>;
    };
    await act(async () => {
      await chatOptions.onToolCall({
        toolCall: {
          dynamic: false,
          input: { projectIds: ['project-2'], renderMode: 'attachments' },
          toolCallId: 'tool-library-artifacts-1',
          toolName: 'getLearningArtifacts',
        },
      });
    });

    useChatMock.mockReturnValue({
      addToolOutput: addToolOutputMock,
      error: undefined,
      messages: [
        {
          id: 'assistant-library-artifacts',
          role: 'assistant',
          parts: [
            {
              type: 'tool-getLearningArtifacts',
              toolCallId: 'tool-library-artifacts-1',
              state: 'output-available',
              input: { projectIds: ['project-2'], renderMode: 'attachments' },
              output: {
                artifactCount: 1,
                artifacts: [crossCourseArtifact.summary],
                renderMode: 'attachments',
                renderedArtifactCount: 1,
              },
            },
          ],
        },
      ],
      sendMessage: sendMessageMock,
      status: 'ready',
    });
    rerender(<ContextAnswerPanel {...props} />);

    expect(screen.getByText('diagramma di routing')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Apri diagramma di routing/i }));
    expect(screen.queryByRole('button', { name: 'Rigenera artefatto' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Scarta artefatto' })).not.toBeInTheDocument();
    expect(screen.queryByText('mappa concettuale')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Chiudi anteprima artefatto' }));
    useChatMock.mockReturnValue({
      addToolOutput: addToolOutputMock,
      error: undefined,
      messages: [
        {
          id: 'assistant-library-artifacts',
          role: 'assistant',
          parts: [
            {
              type: 'tool-getLearningArtifacts',
              toolCallId: 'tool-library-artifacts-1',
              state: 'output-available',
              input: { projectIds: ['project-2'], renderMode: 'attachments' },
              output: {
                artifactCount: 1,
                artifacts: [crossCourseArtifact.summary],
                renderMode: 'attachments',
                renderedArtifactCount: 1,
              },
            },
            {
              type: 'tool-requestAddToNotes',
              toolCallId: 'tool-save-library-artifact',
              state: 'input-available',
              input: {
                artifactIds: [crossCourseArtifact.summary.id],
                noteDraft: 'Confronta il diagramma recuperato.',
                rationale: 'Il confronto chiarisce la lezione corrente.',
                selectedTextDraft: 'G-buffer',
              },
            },
          ],
        },
      ],
      sendMessage: sendMessageMock,
      status: 'ready',
    });
    rerender(<ContextAnswerPanel {...props} />);
    await user.click(screen.getByRole('button', { name: 'Aggiungi alle note' }));

    expect(onSaveConversationNote).toHaveBeenCalledWith(
      { lessonId: 'lesson-1', projectId: 'project-1' },
      expect.objectContaining({
        generatedVisuals: [crossCourseArtifact.visual],
      })
    );

    addToolOutputMock.mockClear();
    const currentLessonOptions = useChatMock.mock.calls.at(-1)?.[0] as {
      onToolCall: (args: {
        toolCall: {
          dynamic: false;
          input: Record<string, never>;
          toolCallId: string;
          toolName: 'getCurrentLessonArtifacts';
        };
      }) => Promise<void>;
    };
    await act(async () => {
      await currentLessonOptions.onToolCall({
        toolCall: {
          dynamic: false,
          input: {},
          toolCallId: 'tool-note-saved-origin-artifacts',
          toolName: 'getCurrentLessonArtifacts',
        },
      });
    });
    expect(addToolOutputMock).toHaveBeenCalledWith(
      expect.objectContaining({
        toolCallId: 'tool-note-saved-origin-artifacts',
        output: expect.objectContaining({
          artifacts: [
            currentLessonArtifact.summary,
            expect.objectContaining({
              id: 'project-1:lesson-1:generated-visual:visual-foreign',
              lessonId: 'lesson-1',
              projectId: 'project-1',
              title: crossCourseArtifact.summary.title,
            }),
          ],
        }),
      })
    );
  });

  test('saves a note when an optional artifact payload is no longer available', async () => {
    const user = userEvent.setup();
    const onSaveConversationNote = vi.fn(async () => ({
      annotationId: 'annotation-without-artifact',
      merged: false,
      saved: true,
    }));
    useChatMock.mockReturnValue({
      addToolOutput: addToolOutputMock,
      error: undefined,
      messages: [
        {
          id: 'assistant-missing-artifact',
          role: 'assistant',
          parts: [
            {
              type: 'tool-requestAddToNotes',
              toolCallId: 'tool-save-missing-artifact',
              state: 'input-available',
              input: {
                artifactIds: ['artifact-no-longer-loaded'],
                noteDraft: 'Conserva il confronto testuale.',
                rationale: 'La nota resta utile anche senza allegato.',
                selectedTextDraft: 'G-buffer',
              },
            },
          ],
        },
      ],
      sendMessage: sendMessageMock,
      status: 'ready',
    });

    render(
      <ContextAnswerPanel
        {...buildProps({ id: 'context-missing-artifact' })}
        onSaveConversationNote={onSaveConversationNote}
      />
    );
    await user.click(screen.getByRole('button', { name: 'Aggiungi alle note' }));

    expect(onSaveConversationNote).toHaveBeenCalledTimes(1);
    expect(addToolOutputMock).toHaveBeenCalledWith({
      tool: 'requestAddToNotes',
      toolCallId: 'tool-save-missing-artifact',
      output: expect.objectContaining({ saved: true }),
    });
  });

  test('rejects a retrieved artifact whose metadata-only result has no payload', async () => {
    const user = userEvent.setup();
    const onSaveConversationNote = vi.fn();
    useChatMock.mockReturnValue({
      addToolOutput: addToolOutputMock,
      error: undefined,
      messages: [
        {
          id: 'assistant-metadata-artifact',
          role: 'assistant',
          parts: [
            {
              type: 'tool-getLearningArtifacts',
              toolCallId: 'tool-metadata-artifacts',
              state: 'output-available',
              input: { projectIds: ['project-2'] },
              output: {
                artifactCount: 1,
                artifacts: [crossCourseArtifact.summary],
                renderMode: 'metadata-only',
                renderedArtifactCount: 0,
              },
            },
            {
              type: 'tool-requestAddToNotes',
              toolCallId: 'tool-save-metadata-artifact',
              state: 'input-available',
              input: {
                artifactIds: [crossCourseArtifact.summary.id],
                noteDraft: 'Conserva il riferimento al diagramma.',
                rationale: 'Il diagramma supporta il confronto.',
                selectedTextDraft: 'G-buffer',
              },
            },
          ],
        },
      ],
      sendMessage: sendMessageMock,
      status: 'ready',
    });

    render(
      <ContextAnswerPanel
        {...buildProps({ id: 'context-metadata-artifact' })}
        onSaveConversationNote={onSaveConversationNote}
      />
    );
    await user.click(screen.getByRole('button', { name: 'Aggiungi alle note' }));

    expect(onSaveConversationNote).not.toHaveBeenCalled();
    expect(addToolOutputMock).toHaveBeenCalledWith({
      tool: 'requestAddToNotes',
      toolCallId: 'tool-save-metadata-artifact',
      output: expect.objectContaining({ approved: true, saved: false }),
    });
  });

  test('rejects a PDF artifact retrieved from another lesson in the current course', async () => {
    const user = userEvent.setup();
    const onSaveConversationNote = vi.fn();
    useChatMock.mockReturnValue({
      addToolOutput: addToolOutputMock,
      error: undefined,
      messages: [
        {
          id: 'assistant-other-lesson-pdf',
          role: 'assistant',
          parts: [
            {
              type: 'tool-requestAddToNotes',
              toolCallId: 'tool-save-other-lesson-pdf',
              state: 'input-available',
              input: {
                artifactIds: [otherLessonPdfArtifact.summary.id],
                noteDraft: 'Nota con immagine di un’altra lezione.',
                rationale: 'Confronto visivo.',
                selectedTextDraft: 'G-buffer',
              },
            },
          ],
        },
      ],
      sendMessage: sendMessageMock,
      status: 'ready',
    });

    render(
      <ContextAnswerPanel
        {...buildProps({ id: 'context-other-lesson-pdf' })}
        currentLessonArtifactPayloads={[currentLessonArtifact, otherLessonPdfArtifact]}
        onSaveConversationNote={onSaveConversationNote}
      />
    );
    await user.click(screen.getByRole('button', { name: 'Aggiungi alle note' }));

    expect(onSaveConversationNote).not.toHaveBeenCalled();
    expect(addToolOutputMock).toHaveBeenCalledWith({
      tool: 'requestAddToNotes',
      toolCallId: 'tool-save-other-lesson-pdf',
      output: expect.objectContaining({ saved: false }),
    });
  });

  test('returns a stable tool error when library retrieval rejects', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    useChatMock.mockReturnValue({
      addToolOutput: addToolOutputMock,
      error: undefined,
      messages: [],
      sendMessage: sendMessageMock,
      status: 'ready',
    });
    const props = buildProps({ id: 'context-library-error' });
    props.libraryAssistantDataSource.loadProjectsById = vi.fn(async () => {
      throw new Error('storage unavailable');
    });

    render(<ContextAnswerPanel {...props} />);

    const chatOptions = useChatMock.mock.calls.at(-1)?.[0] as {
      onToolCall: (args: {
        toolCall: {
          dynamic: false;
          input: Record<string, never>;
          toolCallId: string;
          toolName: string;
        };
      }) => Promise<void>;
    };
    await act(async () => {
      await chatOptions.onToolCall({
        toolCall: {
          dynamic: false,
          input: {},
          toolCallId: 'tool-library-error-1',
          toolName: 'getProjectOverviews',
        },
      });
    });

    expect(addToolOutputMock).toHaveBeenCalledWith({
      tool: 'getProjectOverviews',
      toolCallId: 'tool-library-error-1',
      state: 'output-error',
      errorText: 'Non sono riuscito a recuperare i dati della libreria.',
    });
    consoleErrorSpy.mockRestore();
  });

  test('reveals retrieved material after the answer and opens an exact note target', async () => {
    const user = userEvent.setup();
    const onOpenLibraryReference = vi.fn();
    useChatMock.mockReturnValue({
      addToolOutput: addToolOutputMock,
      error: undefined,
      messages: [
        {
          id: 'assistant-cross-course',
          role: 'assistant',
          parts: [
            {
              type: 'tool-searchLibrary',
              toolCallId: 'tool-library',
              state: 'output-available',
              input: { query: 'routing dinamico' },
              output: {
                hits: [
                  {
                    annotationId: 'annotation-2',
                    kind: 'annotation',
                    lessonId: 'lesson-2',
                    lessonTitle: 'Routing',
                    note: 'Confrontare i protocolli.',
                    projectId: 'project-2',
                    projectTitle: 'Reti',
                    snippet: 'Protocollo distance-vector',
                  },
                ],
              },
            },
            {
              type: 'tool-searchWeb',
              toolCallId: 'tool-web',
              state: 'output-available',
              input: { query: 'routing dinamico' },
              output: { sources: [] },
            },
            {
              type: 'tool-getProjectStructures',
              toolCallId: 'tool-structure',
              state: 'output-available',
              input: { projectIds: ['project-3'] },
              output: {
                projects: [
                  {
                    id: 'project-3',
                    sections: [{ id: 'lesson-3', title: 'BGP' }],
                    title: 'Reti avanzate',
                  },
                ],
              },
            },
            {
              type: 'tool-retrieveSourceArchive',
              toolCallId: 'tool-archive',
              state: 'output-available',
              input: { operation: 'read-file', path: 'src/client.cpp' },
              output: { status: 'ok' },
            },
            {
              type: 'text',
              text: 'Lezione corrente e materiale recuperato restano distinti.',
              state: 'done',
            },
          ],
        },
      ],
      sendMessage: sendMessageMock,
      status: 'ready',
    });

    render(
      <ContextAnswerPanel
        {...buildProps({ id: 'context-cross-course' })}
        onOpenLibraryReference={onOpenLibraryReference}
      />
    );

    const activity = screen.getByTestId('chat-tool-activity');
    expect(within(activity).getByText('Ricerca contenuti')).toBeInTheDocument();
    expect(within(activity).getByText('Ricerca web')).toBeInTheDocument();
    expect(within(activity).getByText('Struttura corsi')).toBeInTheDocument();
    expect(within(activity).getByText('Consulta sorgente')).toBeInTheDocument();
    expect(activity).toHaveTextContent('→');
    const retrievedMaterial = screen.getByTestId('library-tool-references');
    expect(retrievedMaterial).not.toHaveAttribute('open');
    expect(
      within(retrievedMaterial).getByText('Materiale recuperato').closest('summary')
    ).toHaveAccessibleName('Materiale recuperato');

    await user.click(within(retrievedMaterial).getByText('Materiale recuperato'));

    expect(retrievedMaterial).toHaveAttribute('open');
    expect(screen.getByRole('button', { name: 'Apri corso "Reti avanzate"' })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Apri lezione "BGP" nel corso "Reti avanzate"' })
    ).toBeNull();

    await user.click(
      screen.getByRole('button', { name: 'Apri nota in "Routing" nel corso "Reti"' })
    );

    expect(onOpenLibraryReference).toHaveBeenCalledWith({
      annotationId: 'annotation-2',
      hasNote: true,
      kind: 'annotation',
      lessonId: 'lesson-2',
      lessonTitle: 'Routing',
      projectId: 'project-2',
      projectTitle: 'Reti',
    });
  });

  test('keeps retrieved material hidden until automatic continuation completes without scrolling', () => {
    const streamingMessage = {
      id: 'assistant-streaming-references',
      role: 'assistant' as const,
      parts: [
        {
          type: 'text',
          text: 'Sto preparando la risposta.',
          state: 'streaming',
        },
      ] as Array<Record<string, unknown>>,
    };
    lastAssistantMessageIsCompleteWithToolCallsMock.mockImplementation(
      ({ messages }: { messages: Array<{ parts: Array<{ type: string }> }> }) =>
        !messages.at(-1)?.parts.some(part => part.type === 'step-start')
    );
    const chatState = {
      addToolOutput: addToolOutputMock,
      error: undefined,
      messages: [streamingMessage],
      sendMessage: sendMessageMock,
      status: 'streaming' as 'ready' | 'streaming',
    };
    useChatMock.mockImplementation(() => chatState);

    const { rerender } = render(<ContextAnswerPanel {...buildProps()} />);
    const messagesContainer = document.querySelector(
      '[data-context-answer-target="messages-scroll"]'
    ) as HTMLDivElement;
    Object.defineProperty(messagesContainer, 'scrollHeight', { configurable: true, value: 640 });
    messagesContainer.scrollTop = 72;

    streamingMessage.parts.push({
      type: 'tool-searchLibrary',
      toolCallId: 'tool-streaming-library',
      state: 'output-available',
      input: { query: 'routing' },
      output: {
        hits: [
          {
            lessonId: 'lesson-2',
            lessonTitle: 'Routing',
            projectId: 'project-2',
            projectTitle: 'Reti',
          },
        ],
      },
    });
    rerender(<ContextAnswerPanel {...buildProps()} />);

    expect(screen.queryByTestId('library-tool-references')).toBeNull();
    expect(messagesContainer.scrollTop).toBe(72);

    streamingMessage.parts[0].state = 'done';
    chatState.status = 'ready';
    rerender(<ContextAnswerPanel {...buildProps()} />);

    expect(screen.queryByTestId('library-tool-references')).toBeNull();
    expect(messagesContainer.scrollTop).toBe(72);

    streamingMessage.parts.push(
      { type: 'step-start' },
      { type: 'text', text: 'Risposta completa.', state: 'done' }
    );
    rerender(<ContextAnswerPanel {...buildProps()} />);

    expect(screen.getByTestId('library-tool-references')).toBeInTheDocument();
    expect(messagesContainer.scrollTop).toBe(72);
  });

  test('keeps retrieved material hidden while note approval pauses the response', () => {
    const pausedMessage = {
      id: 'assistant-paused-references',
      role: 'assistant' as const,
      parts: [
        { type: 'text', text: 'Ho trovato materiale pertinente.', state: 'done' },
        {
          type: 'tool-searchLibrary',
          toolCallId: 'tool-paused-library',
          state: 'output-available',
          input: { query: 'routing' },
          output: {
            hits: [
              {
                hasContent: true,
                lessonId: 'lesson-2',
                lessonTitle: 'Routing',
                projectId: 'project-2',
                projectTitle: 'Reti',
              },
            ],
          },
        },
        {
          type: 'tool-requestAddToNotes',
          toolCallId: 'tool-paused-note',
          state: 'input-available',
          input: {
            noteDraft: 'Nota sul routing',
            rationale: 'Conserva il passaggio utile.',
            selectedTextDraft: 'Routing',
          },
        },
      ] as Array<Record<string, unknown>>,
    };
    useChatMock.mockReturnValue({
      addToolOutput: addToolOutputMock,
      error: undefined,
      messages: [pausedMessage],
      sendMessage: sendMessageMock,
      status: 'ready',
    });

    render(<ContextAnswerPanel {...buildProps()} />);

    expect(screen.getByRole('button', { name: 'Aggiungi alle note' })).toBeInTheDocument();
    expect(screen.queryByTestId('library-tool-references')).toBeNull();
  });

  test('keeps retrieved material hidden after a partially streamed response fails', () => {
    useChatMock.mockReturnValue({
      addToolOutput: addToolOutputMock,
      error: new Error('stream failed'),
      messages: [
        {
          id: 'assistant-failed-references',
          role: 'assistant',
          parts: [
            { type: 'text', text: 'Risposta incompleta.', state: 'streaming' },
            {
              type: 'tool-searchLibrary',
              toolCallId: 'tool-failed-library',
              state: 'output-available',
              input: { query: 'routing' },
              output: {
                hits: [
                  {
                    hasContent: true,
                    lessonId: 'lesson-2',
                    lessonTitle: 'Routing',
                    projectId: 'project-2',
                    projectTitle: 'Reti',
                  },
                ],
              },
            },
          ],
        },
      ],
      sendMessage: sendMessageMock,
      status: 'error',
    });

    render(<ContextAnswerPanel {...buildProps()} />);

    expect(screen.getByText('Risposta incompleta.')).toBeInTheDocument();
    expect(screen.queryByTestId('library-tool-references')).toBeNull();
  });

  test('keeps retrieved material hidden when a tool-only continuation fails', () => {
    useChatMock.mockReturnValue({
      addToolOutput: addToolOutputMock,
      error: new Error('continuation failed'),
      messages: [
        {
          id: 'assistant-failed-tool-only-references',
          role: 'assistant',
          parts: [
            {
              type: 'tool-searchLibrary',
              toolCallId: 'tool-failed-only-library',
              state: 'output-available',
              input: { query: 'routing' },
              output: {
                hits: [
                  {
                    hasContent: true,
                    lessonId: 'lesson-2',
                    lessonTitle: 'Routing',
                    projectId: 'project-2',
                    projectTitle: 'Reti',
                  },
                ],
              },
            },
          ],
        },
      ],
      sendMessage: sendMessageMock,
      status: 'error',
    });

    render(<ContextAnswerPanel {...buildProps()} />);

    expect(screen.getByTestId('chat-tool-activity')).toBeInTheDocument();
    expect(screen.queryByTestId('library-tool-references')).toBeNull();
  });

  test('keeps an expanded completed-turn disclosure mounted while a later answer streams', async () => {
    const user = userEvent.setup();
    const completedMessage = {
      id: 'assistant-completed-references',
      role: 'assistant' as const,
      parts: [
        { type: 'text', text: 'Prima risposta completa.', state: 'done' },
        {
          type: 'tool-searchLibrary',
          toolCallId: 'tool-completed-library',
          state: 'output-available',
          input: { query: 'routing' },
          output: {
            hits: [
              {
                hasContent: true,
                lessonId: 'lesson-2',
                lessonTitle: 'Routing',
                projectId: 'project-2',
                projectTitle: 'Reti',
              },
            ],
          },
        },
      ],
    };
    const chatState = {
      addToolOutput: addToolOutputMock,
      error: undefined,
      messages: [completedMessage] as Array<Record<string, unknown>>,
      sendMessage: sendMessageMock,
      status: 'ready' as 'ready' | 'streaming',
    };
    useChatMock.mockImplementation(() => chatState);

    const { rerender } = render(<ContextAnswerPanel {...buildProps()} />);
    const completedDisclosure = screen.getByTestId('library-tool-references');
    await user.click(within(completedDisclosure).getByText('Materiale recuperato'));
    expect(completedDisclosure).toHaveAttribute('open');

    chatState.messages.push(
      {
        id: 'user-follow-up',
        role: 'user',
        parts: [{ type: 'text', text: 'Approfondisci.', state: 'done' }],
      },
      {
        id: 'assistant-active-stream',
        role: 'assistant',
        parts: [{ type: 'text', text: 'Seconda risposta in corso.', state: 'streaming' }],
      }
    );
    chatState.status = 'streaming';
    rerender(<ContextAnswerPanel {...buildProps()} />);

    expect(completedDisclosure).toBeInTheDocument();
    expect(completedDisclosure).toHaveAttribute('open');
    expect(screen.getAllByTestId('library-tool-references')).toHaveLength(1);
  });

  test('marks a recovered lesson without generated content as unavailable', async () => {
    const user = userEvent.setup();
    const onOpenLibraryReference = vi.fn();
    useChatMock.mockReturnValue({
      addToolOutput: addToolOutputMock,
      error: undefined,
      messages: [
        {
          id: 'assistant-unavailable-lesson',
          role: 'assistant',
          parts: [
            {
              type: 'tool-getLessonDetails',
              toolCallId: 'tool-unavailable-lesson',
              state: 'output-available',
              input: { requests: [{ projectId: 'project-2', lessonIds: ['lesson-2'] }] },
              output: {
                lessonsByProject: [
                  {
                    projectId: 'project-2',
                    projectTitle: 'Reti',
                    lessons: [{ content: '', id: 'lesson-2', title: 'Routing' }],
                  },
                ],
              },
            },
          ],
        },
      ],
      sendMessage: sendMessageMock,
      status: 'ready',
    });

    render(
      <ContextAnswerPanel
        {...buildProps({ id: 'context-unavailable-lesson' })}
        onOpenLibraryReference={onOpenLibraryReference}
      />
    );

    await user.click(
      within(screen.getByTestId('library-tool-references')).getByText('Materiale recuperato')
    );

    const unavailableLesson = screen.getByRole('button', {
      name: 'Routing: Lezione non ancora generata',
    });
    expect(unavailableLesson).toBeDisabled();
    await user.click(unavailableLesson);
    expect(onOpenLibraryReference).not.toHaveBeenCalled();
  });

  test('marks a recovered annotation on a contentless lesson as unavailable', async () => {
    const user = userEvent.setup();
    const onOpenLibraryReference = vi.fn();
    useChatMock.mockReturnValue({
      addToolOutput: addToolOutputMock,
      error: undefined,
      messages: [
        {
          id: 'assistant-unavailable-annotation',
          role: 'assistant',
          parts: [
            {
              type: 'tool-searchLibrary',
              toolCallId: 'tool-unavailable-annotation',
              state: 'output-available',
              input: { query: 'nota routing' },
              output: {
                hits: [
                  {
                    anchorKind: 'selection',
                    annotationId: 'annotation-2',
                    hasContent: false,
                    lessonId: 'lesson-2',
                    lessonTitle: 'Routing',
                    note: 'Nota routing',
                    projectId: 'project-2',
                    projectTitle: 'Reti',
                  },
                ],
              },
            },
          ],
        },
      ],
      sendMessage: sendMessageMock,
      status: 'ready',
    });

    render(
      <ContextAnswerPanel
        {...buildProps({ id: 'context-unavailable-annotation' })}
        onOpenLibraryReference={onOpenLibraryReference}
      />
    );

    await user.click(
      within(screen.getByTestId('library-tool-references')).getByText('Materiale recuperato')
    );
    const unavailableAnnotation = screen.getByRole('button', {
      name: 'Routing: Lezione non ancora generata',
    });
    expect(unavailableAnnotation).toBeDisabled();
    await user.click(unavailableAnnotation);
    expect(onOpenLibraryReference).not.toHaveBeenCalled();
  });

  test('marks a recovered artifact on a contentless lesson as unavailable', async () => {
    const user = userEvent.setup();
    const onOpenLibraryReference = vi.fn();
    useChatMock.mockReturnValue({
      addToolOutput: addToolOutputMock,
      error: undefined,
      messages: [
        {
          id: 'assistant-unavailable-artifact',
          role: 'assistant',
          parts: [
            {
              type: 'tool-getLearningArtifacts',
              toolCallId: 'tool-unavailable-artifact',
              state: 'output-available',
              input: { projectIds: ['project-2'] },
              output: {
                artifacts: [
                  {
                    ...crossCourseArtifact.summary,
                    hasContent: false,
                  },
                ],
              },
            },
          ],
        },
      ],
      sendMessage: sendMessageMock,
      status: 'ready',
    });

    render(
      <ContextAnswerPanel
        {...buildProps({ id: 'context-unavailable-artifact' })}
        onOpenLibraryReference={onOpenLibraryReference}
      />
    );

    await user.click(
      within(screen.getByTestId('library-tool-references')).getByText('Materiale recuperato')
    );
    const unavailableArtifact = screen.getByRole('button', {
      name: 'Routing: Lezione non ancora generata',
    });
    expect(unavailableArtifact).toBeDisabled();
    await user.click(unavailableArtifact);
    expect(onOpenLibraryReference).not.toHaveBeenCalled();
  });

  test('opens a note-less inline highlight at its exact passage', async () => {
    const user = userEvent.setup();
    const onOpenLibraryReference = vi.fn();
    useChatMock.mockReturnValue({
      addToolOutput: addToolOutputMock,
      error: undefined,
      messages: [
        {
          id: 'assistant-highlight',
          role: 'assistant',
          parts: [
            {
              type: 'tool-getLessonDetails',
              toolCallId: 'tool-highlight',
              state: 'output-available',
              input: { requests: [{ projectId: 'project-2', lessonIds: ['lesson-2'] }] },
              output: {
                lessonsByProject: [
                  {
                    projectId: 'project-2',
                    projectTitle: 'Reti',
                    lessons: [
                      {
                        id: 'lesson-2',
                        title: 'Routing',
                        annotations: [
                          {
                            anchorKind: 'selection',
                            annotationId: 'highlight-2',
                            note: '',
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            },
          ],
        },
      ],
      sendMessage: sendMessageMock,
      status: 'ready',
    });

    render(
      <ContextAnswerPanel
        {...buildProps({ id: 'context-highlight' })}
        onOpenLibraryReference={onOpenLibraryReference}
      />
    );

    await user.click(
      screen.getByRole('button', {
        name: 'Apri evidenziazione in "Routing" nel corso "Reti"',
      })
    );
    expect(onOpenLibraryReference).toHaveBeenCalledWith({
      annotationId: 'highlight-2',
      hasNote: false,
      kind: 'annotation',
      lessonId: 'lesson-2',
      lessonTitle: 'Routing',
      projectId: 'project-2',
      projectTitle: 'Reti',
    });
  });

  test('opens a lesson-level note at its lesson instead of revealing a missing highlight', async () => {
    const user = userEvent.setup();
    const onOpenLibraryReference = vi.fn();
    useChatMock.mockReturnValue({
      addToolOutput: addToolOutputMock,
      error: undefined,
      messages: [
        {
          id: 'assistant-lesson-note',
          role: 'assistant',
          parts: [
            {
              type: 'tool-searchLibrary',
              toolCallId: 'tool-lesson-note',
              state: 'output-available',
              input: { query: 'riepilogo' },
              output: {
                hits: [
                  {
                    anchorKind: 'lesson',
                    annotationId: 'lesson-note-1',
                    kind: 'annotation',
                    lessonId: 'lesson-2',
                    lessonTitle: 'Routing',
                    note: 'Riepilogo della lezione.',
                    projectId: 'project-2',
                    projectTitle: 'Reti',
                  },
                ],
              },
            },
          ],
        },
      ],
      sendMessage: sendMessageMock,
      status: 'ready',
    });

    render(
      <ContextAnswerPanel
        {...buildProps({ id: 'context-lesson-note' })}
        onOpenLibraryReference={onOpenLibraryReference}
      />
    );

    await user.click(
      screen.getByRole('button', { name: 'Apri lezione "Routing" nel corso "Reti"' })
    );
    expect(onOpenLibraryReference).toHaveBeenCalledWith({
      annotationId: undefined,
      kind: 'lesson',
      lessonId: 'lesson-2',
      lessonTitle: 'Routing',
      projectId: 'project-2',
      projectTitle: 'Reti',
    });
  });

  test.each([
    { actionLabel: /Scarta artefatto/i, actionName: 'discard' },
    { actionLabel: /Sostituisci artefatto/i, actionName: 'replace' },
  ])('shares regeneration lifecycle across source and draft surfaces on $actionName', async ({
    actionLabel,
    actionName,
  }) => {
    const user = userEvent.setup();
    let onToolCall:
      | ((args: {
          toolCall: {
            dynamic: false;
            input: Record<string, unknown>;
            toolCallId: string;
            toolName: 'getCurrentLessonArtifacts';
          };
        }) => Promise<void>)
      | undefined;
    let resolveReplacement: ((result: { error: string; succeeded: false }) => void) | undefined;
    const pendingReplacement = new Promise<{ error: string; succeeded: false }>(resolve => {
      resolveReplacement = resolve;
    });
    const onReplaceArtifactInLesson =
      actionName === 'replace'
        ? vi
            .fn()
            .mockImplementationOnce(() => pendingReplacement)
            .mockResolvedValue({ succeeded: true })
        : vi.fn().mockResolvedValue({ succeeded: true });
    generateLessonArtifactDraftMock.mockResolvedValue({
      artifactId: replacementDraftArtifact.summary.id,
      payload: replacementDraftArtifact,
      visual: replacementDraftArtifact.visual,
    });
    useChatMock.mockImplementation(options => {
      onToolCall = options.onToolCall;
      return {
        addToolOutput: addToolOutputMock,
        error: undefined,
        messages: [
          {
            id: 'assistant-artifacts-regeneration',
            role: 'assistant',
            parts: [
              {
                type: 'tool-getCurrentLessonArtifacts',
                toolCallId: 'tool-artifacts-regeneration',
                state: 'output-available',
                input: {},
                output: {
                  artifactCount: 1,
                  artifacts: [currentLessonArtifact.summary],
                  renderMode: 'attachments',
                  renderedArtifactCount: 1,
                },
              },
            ],
          },
        ],
        sendMessage: sendMessageMock,
        status: 'ready',
      };
    });

    render(
      <ContextAnswerPanel
        {...buildProps({ id: `context-multi-surface-${actionName}` })}
        onReplaceArtifactInLesson={onReplaceArtifactInLesson}
      />
    );

    await user.click(screen.getByRole('button', { name: /Apri mappa concettuale$/i }));
    await user.click(screen.getByRole('button', { name: /Rigenera artefatto/i }));
    const sourceDialog = screen.getByRole('dialog', { name: /mappa concettuale/i });
    await user.type(
      within(sourceDialog).getByLabelText(/Istruzioni rigenerazione/i),
      'Rendi la mappa piu leggibile.'
    );
    await user.click(within(sourceDialog).getByRole('button', { name: /Conferma rigenerazione/i }));

    const draftButton = await screen.findByRole('button', {
      name: /Apri mappa concettuale rivista/i,
    });
    expect(generateLessonArtifactDraftMock).toHaveBeenCalledWith(
      expect.objectContaining({
        requestKey: `context-replacement-${currentLessonArtifact.summary.id}`,
      })
    );
    expect(screen.queryByRole('button', { name: /Apri mappa concettuale$/i })).toBeNull();
    expect(screen.queryByText('Nuova bozza pronta.')).toBeNull();

    await user.click(draftButton);
    await user.click(screen.getByRole('button', { name: actionLabel }));

    if (actionName === 'replace') {
      expect(screen.queryByRole('button', { name: /Apri mappa concettuale$/i })).toBeNull();
      expect(
        screen.getByRole('dialog', { name: /mappa concettuale rivista/i })
      ).toBeInTheDocument();

      await act(async () => {
        resolveReplacement?.({
          error: 'Il corso originale non è più attivo.',
          succeeded: false,
        });
        await pendingReplacement;
      });
      expect(await screen.findByText('Il corso originale non è più attivo.')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Apri mappa concettuale$/i })).toBeNull();
      expect(
        screen.getByRole('dialog', { name: /mappa concettuale rivista/i })
      ).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: actionLabel }));
    }

    const persistedArtifactButtonName =
      actionName === 'replace' ? /Apri mappa concettuale rivista$/i : /Apri mappa concettuale$/i;
    expect(
      await screen.findByRole('button', { name: persistedArtifactButtonName })
    ).toBeInTheDocument();
    expect(screen.queryByText('Nuova bozza pronta.')).toBeNull();
    if (actionName === 'replace') {
      expect(onReplaceArtifactInLesson).toHaveBeenLastCalledWith(
        { lessonId: 'lesson-1', projectId: 'project-1' },
        currentLessonArtifact.summary.id,
        replacementDraftArtifact.visual
      );
      expect(onReplaceArtifactInLesson).toHaveBeenCalledTimes(2);

      addToolOutputMock.mockClear();
      await act(async () => {
        await onToolCall?.({
          toolCall: {
            dynamic: false,
            input: {},
            toolCallId: 'tool-replaced-origin-artifacts',
            toolName: 'getCurrentLessonArtifacts',
          },
        });
      });
      expect(addToolOutputMock).toHaveBeenCalledWith(
        expect.objectContaining({
          toolCallId: 'tool-replaced-origin-artifacts',
          output: expect.objectContaining({
            artifacts: [
              expect.objectContaining({
                id: currentLessonArtifact.summary.id,
                title: replacementDraftArtifact.summary.title,
              }),
            ],
          }),
        })
      );
    }
  });

  test('shows fallback buttons after grace period when requestAddToNotes input is invalid', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-05-04T00:00:00Z'));

    useChatMock.mockReturnValue({
      addToolOutput: addToolOutputMock,
      error: undefined,
      messages: [
        {
          id: 'assistant-1',
          role: 'assistant',
          parts: [
            {
              type: 'tool-requestAddToNotes',
              toolCallId: 'tool-stuck-1',
              state: 'input-available',
              input: null,
            },
          ],
        },
      ],
      sendMessage: sendMessageMock,
      status: 'ready',
    });

    render(<ContextAnswerPanel {...buildProps()} />);

    // Before grace: still showing spinner
    expect(screen.getByText('Sto caricando i dettagli della nota proposta...')).toBeTruthy();

    // Advance past grace period (2s): fallback warning + "No grazie" button
    await act(() => vi.advanceTimersByTimeAsync(3_000));

    expect(screen.getByText('Suggerimento non disponibile. Puoi riprovare.')).toBeTruthy();
    expect(screen.getAllByText('No grazie').length).toBeGreaterThanOrEqual(1);
    expect(addToolOutputMock).not.toHaveBeenCalled();

    vi.useRealTimers();
  });

  test('auto-rejects stuck requestAddToNotes after hard timeout', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-05-04T00:00:00Z'));

    useChatMock.mockReturnValue({
      addToolOutput: addToolOutputMock,
      error: undefined,
      messages: [
        {
          id: 'assistant-1',
          role: 'assistant',
          parts: [
            {
              type: 'tool-requestAddToNotes',
              toolCallId: 'tool-stuck-2',
              state: 'input-available',
              input: undefined,
            },
          ],
        },
      ],
      sendMessage: sendMessageMock,
      status: 'ready',
    });

    render(<ContextAnswerPanel {...buildProps()} />);

    // Hard timeout (15s): auto-reject
    await act(() => vi.advanceTimersByTimeAsync(16_000));

    expect(addToolOutputMock).toHaveBeenCalledWith({
      tool: 'requestAddToNotes',
      toolCallId: 'tool-stuck-2',
      output: { approved: false, mode: 'none', saved: false },
    });

    vi.useRealTimers();
  });

  test('does not apply fallback timer when requestAddToNotes input is valid', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-05-04T00:00:00Z'));

    useChatMock.mockReturnValue({
      addToolOutput: addToolOutputMock,
      error: undefined,
      messages: [
        {
          id: 'assistant-1',
          role: 'assistant',
          parts: [
            {
              type: 'tool-requestAddToNotes',
              toolCallId: 'tool-ok',
              state: 'input-available',
              input: {
                noteDraft: 'Nota di test',
                rationale: 'Vale la pena',
                selectedTextDraft: 'G-buffer',
              },
            },
          ],
        },
      ],
      sendMessage: sendMessageMock,
      status: 'ready',
    });

    render(<ContextAnswerPanel {...buildProps()} />);

    // Valid input should show approve button immediately
    const approveButtons = screen.getAllByText('Aggiungi alle note');
    expect(approveButtons.length).toBeGreaterThanOrEqual(1);
    expect(addToolOutputMock).not.toHaveBeenCalled();

    // Advance past hard timeout — still no auto-reject
    await act(() => vi.advanceTimersByTimeAsync(20_000));
    expect(addToolOutputMock).not.toHaveBeenCalled();

    vi.useRealTimers();
  });
});
