// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { act, render, screen } from '@testing-library/react';
import { createRef, StrictMode } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const defaultChatTransportInstances: Array<{
  prepareSendMessagesRequest?: (args: unknown) => unknown;
}> = [];
const sendMessageMock = vi.fn();
const addToolOutputMock = vi.fn();
const useChatMock = vi.fn();
const chatTextComposerProps: Array<{
  disabled?: boolean;
  onSubmit: () => void;
  placeholder: string;
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
    onSubmit: () => void;
    placeholder: string;
    value: string;
  }) => {
    chatTextComposerProps.push(props);
    return (
      <button
        type="button"
        data-testid="chat-text-composer"
        disabled={props.disabled}
        onClick={props.onSubmit}
      >
        {props.placeholder}
      </button>
    );
  },
}));

vi.mock('../../../../services/openrouter/config.ts', () => ({
  getBackendUrl: () => 'http://localhost:3301',
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

const buildProps = () => ({
  contextAnswer: {
    id: 'context-1',
    initialQuestion: 'spiega meglio',
    selectedText: 'G-buffer',
    lessonContent: 'Contenuto',
    lessonDescription: 'Descrizione',
    lessonTitle: 'Titolo',
  },
  contextAnswerPanelRef: createRef<HTMLDivElement>(),
  contextAnswerSize: { width: 360, height: 280 },
  handleContextAnswerResizeStart: vi.fn(),
  isDarkMode: false,
  isMobileViewport: false,
  onClose: vi.fn(),
  preferredContextModel: 'openai/gpt-5.4-mini',
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
    chatTextComposerProps.length = 0;
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
        <ContextAnswerPanel {...buildProps()} />
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

  test('sends the preferred context model override with context chat requests', () => {
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
      id: 'chat-1',
      messages: [{ role: 'user', parts: [{ type: 'text', text: 'spiega meglio' }] }],
    }) as { body?: Record<string, unknown> };

    expect(request.body?.modelOverride).toBe('openai/gpt-5.4-mini');
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

  test('uses the latest preferred context model after rerender on the initial transport instance', () => {
    useChatMock.mockReturnValue({
      addToolOutput: addToolOutputMock,
      error: undefined,
      messages: [],
      sendMessage: sendMessageMock,
      status: 'ready',
    });

    const { rerender } = render(<ContextAnswerPanel {...buildProps()} preferredContextModel="" />);

    const transport = defaultChatTransportInstances[0];
    expect(transport?.prepareSendMessagesRequest).toBeTypeOf('function');

    rerender(<ContextAnswerPanel {...buildProps()} preferredContextModel="openai/gpt-5.4-nano" />);

    const request = transport?.prepareSendMessagesRequest?.({
      id: 'chat-2',
      messages: [{ role: 'user', parts: [{ type: 'text', text: 'spiega meglio' }] }],
    }) as { body?: Record<string, unknown> };

    expect(request.body?.modelOverride).toBe('openai/gpt-5.4-nano');
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
