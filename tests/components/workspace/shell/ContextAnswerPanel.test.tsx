// @vitest-environment jsdom
import { StrictMode, createRef } from 'react';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const sendMessageMock = vi.fn();
const addToolOutputMock = vi.fn();
const useChatMock = vi.fn();

vi.mock('@ai-sdk/react', () => ({
  useChat: useChatMock,
}));

vi.mock('ai', () => ({
  DefaultChatTransport: class DefaultChatTransport {},
  isTextUIPart: (part: { type?: string }) => part?.type === 'text',
  isToolUIPart: (part: { type?: string }) => typeof part?.type === 'string' && part.type.startsWith('tool-'),
  lastAssistantMessageIsCompleteWithToolCalls: () => false,
}));

vi.mock('../../../../components/shared/MarkdownRenderer.tsx', () => ({
  default: ({ content }: { content: string }) => <div data-testid="markdown-renderer">{content}</div>,
}));

vi.mock('../../../../components/workspace/chat/ChatTextComposer.tsx', () => ({
  default: () => <div data-testid="chat-text-composer" />,
}));

vi.mock('../../../../services/openrouter/config.ts', () => ({
  getBackendUrl: () => 'http://localhost:3001',
}));

const { default: ContextAnswerPanel } = await import('../../../../components/workspace/shell/ContextAnswerPanel.tsx');

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
  onSaveConversationNote: vi.fn(),
  onUpdateConversationNote: vi.fn(),
});

describe('ContextAnswerPanel', () => {
  beforeEach(() => {
    sendMessageMock.mockReset();
    addToolOutputMock.mockReset();
    useChatMock.mockReset();
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
    expect(markdownBlocks).toHaveLength(2);
    expect(markdownBlocks[0]).toHaveTextContent('Prima della nota.');
    expect(markdownBlocks[1]).toHaveTextContent('Dopo la nota.');

    const renderedText = container.textContent || '';
    expect(renderedText.indexOf('Prima della nota.')).toBeLessThan(
      renderedText.indexOf('Vuoi aggiungerlo alle note?')
    );
    expect(renderedText.indexOf('Vuoi aggiungerlo alle note?')).toBeLessThan(
      renderedText.indexOf('Dopo la nota.')
    );
  });
});
