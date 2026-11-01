// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createUIMessageStream, createUIMessageStreamResponse, type UIMessage } from 'ai';
import { createRef } from 'react';
import { beforeEach, expect, test, vi } from 'vitest';
import ContextAnswerPanel from '../../../../components/workspace/shell/ContextAnswerPanel.tsx';

const flow = vi.hoisted(() => ({
  requests: [] as Array<{ messages: UIMessage[]; lessonContent: string; noteCatalog: unknown }>,
  events: [] as Array<Record<string, unknown>>,
  passages: ['invented', 'p0'],
  beforeReply: undefined as ((index: number) => Promise<void>) | undefined,
}));
vi.mock('../../../../services/auth/supabaseAuth.ts', () => ({
  fetchWithSupabaseAuth: async (url: string, init: RequestInit) => {
    const request = JSON.parse(init.body as string);
    if (url.endsWith('/note-events')) {
      flow.events.push(request);
      return new Response(null, { status: 204 });
    }
    const index = flow.requests.push(request) - 1;
    await flow.beforeReply?.(index);
    return createUIMessageStreamResponse({
      stream: createUIMessageStream({
        execute: ({ writer }) => {
          const previous = request.messages.at(-1);
          writer.write({
            type: 'start',
            messageId: previous?.role === 'assistant' ? previous.id : `assistant-${index}`,
          });
          writer.write({ type: 'start-step' });
          writer.write({
            type: 'tool-input-available',
            toolCallId: `note-${index}`,
            toolName: 'requestAddToNotes',
            input: {
              noteDraft: 'Il Sole provoca evaporazione.',
              rationale: 'Conserva il concetto.',
              passageId: flow.passages[index] ?? 'invented',
            },
          });
          writer.write({ type: 'finish-step' });
          writer.write({ type: 'finish' });
        },
      }),
    });
  },
}));

const context = (lessonContent = 'Il Sole scalda l’acqua.') => ({
  id: `correction-${expect.getState().currentTestName}`,
  initialQuestion: 'Proponi una nota.',
  contextScope: 'lesson' as const,
  selectedText: '',
  lessonContent,
  lessonDescription: 'Scienze',
  lessonId: 'water',
  lessonTitle: 'Acqua',
  projectId: 'science',
  projectTitle: 'Scienze',
});
const save = vi.fn(async () => ({ saved: true, merged: false, annotationId: 'saved-note' }));
const panel = (lessonContent?: string) => (
  <ContextAnswerPanel
    contextAnswer={context(lessonContent)}
    contextAnswerPanelRef={createRef<HTMLDivElement>()}
    contextAnswerSize={{ width: 600, height: 500 }}
    handleContextAnswerResizeStart={() => {}}
    isDarkMode={false}
    isMobileViewport={false}
    libraryAssistantDataSource={{
      attachedContextRefs: [],
      folders: [],
      loadProjectsById: async () => [],
      projects: [],
      tree: {
        descendantProjectIdsByFolderId: {},
        folderById: {},
        placementByProjectId: {},
        rootNodes: [],
      },
    }}
    onClose={() => {}}
    onOpenLibraryReference={() => {}}
    onSaveConversationNote={save}
    onUpdateConversationNote={save}
  />
);
const drain = () =>
  act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });
beforeEach(() => {
  flow.requests.length = 0;
  flow.events.length = 0;
  flow.passages = ['invented', 'p0'];
  flow.beforeReply = undefined;
  save.mockClear();
});

test('one automatic choose_passage correction preserves the draft and still requires approval', async () => {
  const user = userEvent.setup();
  render(panel());
  const approve = await screen.findByRole('button', { name: 'Aggiungi alle note' });
  expect(flow.requests).toHaveLength(2);
  expect(flow.requests[1].messages.filter(message => message.role === 'user')).toHaveLength(1);
  expect(flow.requests[1].messages.flatMap(message => message.parts)).toContainEqual(
    expect.objectContaining({
      output: {
        status: 'validation_error',
        code: 'unknown_passage',
        recovery: 'choose_passage',
        availablePassageIds: ['p0'],
      },
    })
  );
  expect(save).not.toHaveBeenCalled();
  const rejected = flow.events.find(
    event => event.phase === 'proposal' && event.outcome === 'validation_error'
  );
  expect(flow.events.filter(event => event.phase === 'correction')).toMatchObject([
    { parentOperationId: rejected?.operationId, recovery: 'choose_passage', outcome: 'requested' },
  ]);
  await user.click(approve);
  await screen.findByText('Nota salvata.');
  await drain();
  expect(flow.requests).toHaveLength(2);
  expect(save).toHaveBeenCalledTimes(1);
});

test('a second invalid proposal stops; the learner can recover the draft and start a new turn', async () => {
  flow.passages = ['invented', 'also-invented', 'invented', 'p0'];
  const user = userEvent.setup();
  render(panel());
  await waitFor(() => expect(flow.requests).toHaveLength(2));
  await waitFor(() =>
    expect(screen.getAllByRole('button', { name: 'Riprendi bozza' })).toHaveLength(2)
  );
  await drain();
  expect(flow.requests).toHaveLength(2);
  expect(screen.getByRole('textbox')).toBeEnabled();
  await user.click(screen.getAllByRole('button', { name: 'Riprendi bozza' })[1]);
  expect(screen.getByRole('textbox')).toHaveValue('Il Sole provoca evaporazione.');
  await user.click(screen.getByRole('button', { name: 'Invia messaggio' }));
  await screen.findByRole('button', { name: 'Aggiungi alle note' });
  expect(flow.requests).toHaveLength(4);
});

test('unavailable context never starts a correction', async () => {
  render(panel('```js\nconst water = 1;\n```'));
  await screen.findByText('Proposta di nota non disponibile.');
  await drain();
  expect(flow.requests).toHaveLength(1);
  expect(screen.getByRole('textbox')).toBeEnabled();
  expect(save).not.toHaveBeenCalled();
});

test('refresh_context sends the rebuilt lesson view instead of the stale snapshot', async () => {
  let release: () => void = () => {};
  flow.beforeReply = index =>
    index === 0
      ? new Promise<void>(resolve => {
          release = resolve;
        })
      : Promise.resolve();
  const view = render(panel());
  await waitFor(() => expect(flow.requests).toHaveLength(1));
  view.rerender(panel('Il vapore si raffredda.'));
  await act(async () => {
    release();
  });
  await screen.findByRole('button', { name: 'Aggiungi alle note' });
  expect(flow.requests).toHaveLength(2);
  expect(flow.requests[1].lessonContent).toBe('Il vapore si raffredda.');
  expect(flow.requests[1].noteCatalog).not.toEqual(flow.requests[0].noteCatalog);
  expect(flow.requests[1].messages.flatMap(message => message.parts)).toContainEqual(
    expect.objectContaining({
      output: {
        status: 'validation_error',
        code: 'stale_context',
        recovery: 'refresh_context',
        availablePassageIds: [],
      },
    })
  );
});

test.each([
  'stop',
  'unmount',
] as const)('%s during correction suppresses its late proposal', async action => {
  let release: () => void = () => {};
  flow.beforeReply = index =>
    index === 1
      ? new Promise<void>(resolve => {
          release = resolve;
        })
      : Promise.resolve();
  const user = userEvent.setup();
  const view = render(panel());
  await waitFor(() => expect(flow.requests).toHaveLength(2));
  if (action === 'stop') await user.click(screen.getByRole('button', { name: 'Annulla' }));
  else view.unmount();
  await act(async () => {
    release();
  });
  await drain();
  expect(screen.queryByRole('button', { name: 'Aggiungi alle note' })).not.toBeInTheDocument();
  expect(flow.requests).toHaveLength(2);
  expect(save).not.toHaveBeenCalled();
  if (action === 'stop') expect(screen.getByRole('textbox')).toBeEnabled();
});
