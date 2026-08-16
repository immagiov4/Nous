// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef, type ReactNode, StrictMode } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { ContextAnswerState } from '../../../../components/workspace/shell/types.ts';

const defaultChatTransportInstances: Array<{
  prepareSendMessagesRequest?: (args: unknown) => unknown;
}> = [];
const sendMessageMock = vi.fn();
const addToolOutputMock = vi.fn();
const useChatMock = vi.fn();
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
  lastAssistantMessageIsCompleteWithToolCalls: () => false,
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
  onClose: vi.fn(),
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

  test('shows distinct context sources and sends provenance without file contents', () => {
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

    expect(screen.getByText(/2 (sources|fonti)/i)).toBeInTheDocument();
    expect(screen.getByTitle('01.pdf, 049.pdf')).toBeInTheDocument();

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
    expect(JSON.stringify(request.body)).not.toContain('PDF-DATA-MUST-NOT-BE-SENT');
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

  test.each([
    { actionLabel: /Scarta artefatto/i, actionName: 'discard' },
    { actionLabel: /Sostituisci artefatto/i, actionName: 'replace' },
  ])('shares regeneration lifecycle across source and draft surfaces on $actionName', async ({
    actionLabel,
    actionName,
  }) => {
    const user = userEvent.setup();
    let rejectReplacement: ((reason?: unknown) => void) | undefined;
    const pendingReplacement = new Promise<void>((_resolve, reject) => {
      rejectReplacement = reject;
    });
    const onReplaceArtifactInLesson =
      actionName === 'replace'
        ? vi
            .fn()
            .mockImplementationOnce(() => pendingReplacement)
            .mockResolvedValue(undefined)
        : vi.fn().mockResolvedValue(undefined);
    const consoleErrorSpy =
      actionName === 'replace' ? vi.spyOn(console, 'error').mockImplementation(() => {}) : null;
    generateLessonArtifactDraftMock.mockResolvedValue({
      artifactId: replacementDraftArtifact.summary.id,
      payload: replacementDraftArtifact,
      visual: replacementDraftArtifact.visual,
    });
    useChatMock.mockReturnValue({
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
        rejectReplacement?.(new Error('replace failed'));
        await pendingReplacement.catch(() => undefined);
      });
      expect(
        await screen.findByText('Operazione non riuscita. L artefatto non e stato modificato.')
      ).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Apri mappa concettuale$/i })).toBeNull();
      expect(
        screen.getByRole('dialog', { name: /mappa concettuale rivista/i })
      ).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: actionLabel }));
    }

    expect(
      await screen.findByRole('button', { name: /Apri mappa concettuale$/i })
    ).toBeInTheDocument();
    expect(screen.queryByText('Nuova bozza pronta.')).toBeNull();
    if (actionName === 'replace') {
      expect(onReplaceArtifactInLesson).toHaveBeenLastCalledWith(
        currentLessonArtifact.summary.id,
        replacementDraftArtifact.visual
      );
      expect(onReplaceArtifactInLesson).toHaveBeenCalledTimes(2);
    }
    consoleErrorSpy?.mockRestore();
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
