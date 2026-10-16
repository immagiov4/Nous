// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createUIMessageStream, createUIMessageStreamResponse, type UIMessage } from 'ai';
import { createRef } from 'react';
import { expect, test, vi } from 'vitest';
import ContextAnswerPanel from '../../../../components/workspace/shell/ContextAnswerPanel.tsx';

const requests = vi.hoisted(() => [] as Array<{ messages: UIMessage[] }>);
vi.mock('../../../../services/auth/supabaseAuth.ts', () => ({
  fetchWithSupabaseAuth: async (_url: string, init: RequestInit) => {
    const request = JSON.parse(init.body as string);
    requests.push(request);
    return createUIMessageStreamResponse({
      stream: createUIMessageStream({
        execute: ({ writer }) => {
          writer.write({ type: 'start', messageId: `assistant-${requests.length}` });
          writer.write({ type: 'start-step' });
          if (requests.length === 1) {
            writer.write({
              type: 'tool-input-available',
              toolCallId: 'save-note',
              toolName: 'requestAddToNotes',
              input: {
                noteDraft: 'Il Sole provoca evaporazione.',
                rationale: 'Conserva il concetto.',
                selectedTextDraft: 'Il Sole scalda l’acqua.',
              },
            });
          } else {
            writer.write({ type: 'text-start', id: 'answer' });
            writer.write({ type: 'text-delta', id: 'answer', delta: 'Risposta successiva.' });
            writer.write({ type: 'text-end', id: 'answer' });
          }
          writer.write({ type: 'finish-step' });
          writer.write({ type: 'finish' });
        },
      }),
    });
  },
}));

test.each([
  'new',
  'update',
] as const)('saving a %s note waits for the next user message before requesting another response', async mode => {
  requests.length = 0;
  const user = userEvent.setup();
  const save = vi.fn(async () => ({
    saved: true,
    annotationId: 'saved-note',
    merged: mode === 'update',
  }));
  render(
    <ContextAnswerPanel
      contextAnswer={{
        id: `save-${mode}`,
        initialQuestion: 'Salva una nota.',
        selectedText: 'Il Sole scalda l’acqua.',
        lessonContent: 'Il Sole scalda l’acqua.',
        lessonDescription: 'Scienze',
        lessonId: 'water',
        lessonTitle: 'Acqua',
        projectId: 'science',
        projectTitle: 'Scienze',
        ...(mode === 'update' ? { attachedAnnotationNote: 'Nota precedente.' } : {}),
      }}
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
  await user.click(
    await screen.findByRole('button', {
      name: mode === 'update' ? 'Aggiorna nota' : 'Aggiungi alle note',
    })
  );
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
  // Drain the real SDK's queued tool-output submission, including its network response.
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  expect(requests).toHaveLength(1);
  await user.type(screen.getByRole('textbox'), 'Spiega la condensazione.');
  await user.click(screen.getByRole('button', { name: 'Invia messaggio' }));
  await screen.findByText('Risposta successiva.');
  expect(requests).toHaveLength(2);
  expect(requests[1].messages.at(-1)).toMatchObject({
    role: 'user',
    parts: [{ type: 'text', text: 'Spiega la condensazione.' }],
  });
  expect(requests[1].messages.flatMap(message => message.parts)).toContainEqual(
    expect.objectContaining({
      type: 'tool-requestAddToNotes',
      state: 'output-available',
      output: expect.objectContaining({ saved: true, annotationId: 'saved-note' }),
    })
  );
});
