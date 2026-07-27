// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';

import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, test, vi } from 'vitest';

import ChatArtifactRenderer, {
  type ChatArtifactRegenerationStates,
} from '../../../components/shared/ChatArtifactRenderer.tsx';
import type { LearningArtifactRenderPayload } from '../../../types.ts';

const pdfArtifact: LearningArtifactRenderPayload = {
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
    projectTitle: 'Basi di dati',
    title: 'Schema ER',
  },
};

const htmlArtifact: LearningArtifactRenderPayload = {
  summary: {
    id: 'project-1:lesson-2:generated-visual:visual-2',
    kind: 'generated-visual',
    lessonId: 'lesson-2',
    lessonTitle: 'Normalizzazione',
    previewMode: 'chip-only',
    projectId: 'project-1',
    projectTitle: 'Basi di dati',
    title: 'simulatore chiusura',
  },
  visual: {
    id: 'visual-2',
    title: 'simulatore_chiusura',
    kind: 'html',
    code: '<style></style><div>Simulazione</div><script></script>',
    createdAt: '2026-05-01T11:00:00.000Z',
  },
};

const replacementDraftArtifact: LearningArtifactRenderPayload = {
  ...htmlArtifact,
  summary: {
    ...htmlArtifact.summary,
    id: 'project-1:lesson-2:generated-visual:visual-draft-3',
    replacementOfArtifactId: htmlArtifact.summary.id,
    title: 'simulatore chiusura rivisto',
  },
  visual: {
    ...htmlArtifact.visual,
    createdAt: '2026-05-01T12:00:00.000Z',
    id: 'visual-draft-3',
    title: 'simulatore_chiusura_rivisto',
  },
};

const latestReplacementDraftArtifact: LearningArtifactRenderPayload = {
  ...replacementDraftArtifact,
  summary: {
    ...replacementDraftArtifact.summary,
    id: 'project-1:lesson-2:generated-visual:visual-draft-4',
    title: 'simulatore chiusura definitivo',
  },
  visual: {
    ...replacementDraftArtifact.visual,
    createdAt: '2026-05-01T13:00:00.000Z',
    id: 'visual-draft-4',
    title: 'simulatore_chiusura_definitivo',
  },
};

describe('ChatArtifactRenderer', () => {
  test('renders image thumbnails and chip-only interactive artifacts', () => {
    render(<ChatArtifactRenderer artifacts={[pdfArtifact, htmlArtifact]} isDarkMode={false} />);

    expect(screen.getByText('simulatore chiusura')).toBeInTheDocument();
    expect(screen.getByText(/Interattivo/i)).toBeInTheDocument();
  });

  test('opens and closes a responsive artifact overlay', async () => {
    const user = userEvent.setup();
    render(<ChatArtifactRenderer artifacts={[pdfArtifact]} isDarkMode={false} />);

    await user.click(screen.getByRole('button', { name: /Apri Schema ER/i }));

    const dialog = screen.getByRole('dialog', { name: /Schema ER/i });
    expect(dialog).toBeInTheDocument();
    expect(dialog.parentElement?.parentElement).toBe(document.body);
    expect(within(dialog).getByRole('img', { name: /Schema ER/i })).toBeInTheDocument();

    await user.keyboard('{Escape}');

    expect(screen.queryByRole('dialog', { name: /Schema ER/i })).not.toBeInTheDocument();
  });

  test('renders visual overlays without the inline article spacing', async () => {
    const user = userEvent.setup();
    render(<ChatArtifactRenderer artifacts={[htmlArtifact]} isDarkMode={true} />);

    await user.click(screen.getByRole('button', { name: /Apri simulatore chiusura/i }));

    expect(screen.getByRole('dialog', { name: /simulatore chiusura/i })).toBeInTheDocument();
  });

  test('closes the overlay and reports regeneration progress in chat', async () => {
    const user = userEvent.setup();
    const onRemoveArtifact = vi.fn();
    let resolveRegeneration: ((value: boolean) => void) | undefined;
    const onRegenerateArtifact = vi.fn(
      () =>
        new Promise<boolean>(resolve => {
          resolveRegeneration = resolve;
        })
    );
    const { rerender } = render(
      <ChatArtifactRenderer
        artifacts={[pdfArtifact, htmlArtifact]}
        isDarkMode={false}
        onRegenerateArtifact={onRegenerateArtifact}
        onRemoveArtifact={onRemoveArtifact}
      />
    );

    await user.click(screen.getByRole('button', { name: /Apri simulatore chiusura/i }));
    await user.click(screen.getByRole('button', { name: /Rigenera artefatto/i }));

    const dialog = screen.getByRole('dialog', { name: /simulatore chiusura/i });
    const submitButton = within(dialog).getByRole('button', { name: /Conferma rigenerazione/i });
    expect(within(dialog).getByLabelText(/Istruzioni rigenerazione/i)).toBeInTheDocument();
    expect(submitButton).toBeDisabled();

    await user.type(
      within(dialog).getByLabelText(/Istruzioni rigenerazione/i),
      'Rendilo piu sintetico e leggibile.'
    );
    await user.click(submitButton);

    expect(screen.queryByRole('dialog', { name: /simulatore chiusura/i })).not.toBeInTheDocument();
    expect(onRegenerateArtifact).toHaveBeenCalledWith({
      artifactId: htmlArtifact.summary.id,
      instructions: 'Rendilo piu sintetico e leggibile.',
    });
    expect(screen.getByRole('status')).toHaveTextContent(
      'Richiesta ricevuta. Sto rigenerando l artefatto...'
    );
    expect(
      screen.queryByRole('button', { name: /Apri simulatore chiusura/i })
    ).not.toBeInTheDocument();

    resolveRegeneration?.(true);
    expect(await screen.findByText('Nuova bozza pronta.')).toBeInTheDocument();

    rerender(
      <ChatArtifactRenderer
        artifacts={[pdfArtifact, htmlArtifact, replacementDraftArtifact]}
        isDarkMode={false}
        onRegenerateArtifact={onRegenerateArtifact}
        onRemoveArtifact={onRemoveArtifact}
      />
    );
    await waitFor(() => expect(screen.queryByText('Nuova bozza pronta.')).not.toBeInTheDocument());
    expect(
      screen.getByRole('button', { name: /Apri simulatore chiusura rivisto/i })
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole('button', { name: /Rimuovi simulatore chiusura rivisto dalla nota/i })
    );
    expect(onRemoveArtifact).toHaveBeenCalledWith(replacementDraftArtifact.summary.id);

    rerender(
      <ChatArtifactRenderer
        artifacts={[pdfArtifact, htmlArtifact]}
        isDarkMode={false}
        onRegenerateArtifact={onRegenerateArtifact}
        onRemoveArtifact={onRemoveArtifact}
      />
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Apri simulatore chiusura/i })).toBeInTheDocument()
    );
    expect(screen.getByRole('button', { name: /Apri Schema ER/i })).toBeInTheDocument();
  });

  test('clears succeeded state when a replacement arrived while regeneration was working', async () => {
    const user = userEvent.setup();
    const onDiscardArtifact = vi.fn();
    let resolveRegeneration: ((value: boolean) => void) | undefined;
    const onRegenerateArtifact = vi.fn(
      () =>
        new Promise<boolean>(resolve => {
          resolveRegeneration = resolve;
        })
    );
    const { rerender } = render(
      <ChatArtifactRenderer
        artifacts={[htmlArtifact]}
        isDarkMode={false}
        onDiscardArtifact={onDiscardArtifact}
        onRegenerateArtifact={onRegenerateArtifact}
      />
    );

    await user.click(screen.getByRole('button', { name: /Apri simulatore chiusura/i }));
    await user.click(screen.getByRole('button', { name: /Rigenera artefatto/i }));
    const dialog = screen.getByRole('dialog', { name: /simulatore chiusura/i });
    await user.type(
      within(dialog).getByLabelText(/Istruzioni rigenerazione/i),
      'Mantieni il contenuto, migliora la leggibilita.'
    );
    await user.click(within(dialog).getByRole('button', { name: /Conferma rigenerazione/i }));

    expect(screen.getByRole('status')).toHaveTextContent(
      'Richiesta ricevuta. Sto rigenerando l artefatto...'
    );
    rerender(
      <ChatArtifactRenderer
        artifacts={[htmlArtifact, replacementDraftArtifact]}
        isDarkMode={false}
        onDiscardArtifact={onDiscardArtifact}
        onRegenerateArtifact={onRegenerateArtifact}
      />
    );
    expect(
      screen.getByRole('button', { name: /Apri simulatore chiusura rivisto/i })
    ).toBeInTheDocument();

    resolveRegeneration?.(true);
    await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /Apri simulatore chiusura rivisto/i }));
    await user.click(screen.getByRole('button', { name: /Scarta artefatto/i }));
    expect(onDiscardArtifact).toHaveBeenCalledWith({
      artifactId: replacementDraftArtifact.summary.id,
    });

    rerender(
      <ChatArtifactRenderer
        artifacts={[htmlArtifact]}
        isDarkMode={false}
        onDiscardArtifact={onDiscardArtifact}
        onRegenerateArtifact={onRegenerateArtifact}
      />
    );
    expect(screen.getByRole('button', { name: /Apri simulatore chiusura/i })).toBeInTheDocument();
  });

  test('clears succeeded state when applying a replacement draft', async () => {
    const user = userEvent.setup();
    const onRegenerateArtifact = vi.fn().mockResolvedValue(true);
    const onReplaceArtifact = vi.fn();
    const { rerender } = render(
      <ChatArtifactRenderer
        artifacts={[htmlArtifact]}
        isDarkMode={false}
        onRegenerateArtifact={onRegenerateArtifact}
        onReplaceArtifact={onReplaceArtifact}
      />
    );

    await user.click(screen.getByRole('button', { name: /Apri simulatore chiusura/i }));
    await user.click(screen.getByRole('button', { name: /Rigenera artefatto/i }));
    const regenerationDialog = screen.getByRole('dialog', { name: /simulatore chiusura/i });
    await user.type(
      within(regenerationDialog).getByLabelText(/Istruzioni rigenerazione/i),
      'Conserva la struttura.'
    );
    await user.click(
      within(regenerationDialog).getByRole('button', { name: /Conferma rigenerazione/i })
    );
    expect(await screen.findByText('Nuova bozza pronta.')).toBeInTheDocument();

    rerender(
      <ChatArtifactRenderer
        artifacts={[htmlArtifact, replacementDraftArtifact]}
        isDarkMode={false}
        onRegenerateArtifact={onRegenerateArtifact}
        onReplaceArtifact={onReplaceArtifact}
      />
    );
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Apri simulatore chiusura rivisto/i }));
    await user.click(screen.getByRole('button', { name: /Sostituisci artefatto/i }));
    expect(onReplaceArtifact).toHaveBeenCalledWith({
      artifactId: replacementDraftArtifact.summary.id,
      replacementOfArtifactId: htmlArtifact.summary.id,
    });

    rerender(
      <ChatArtifactRenderer
        artifacts={[htmlArtifact]}
        isDarkMode={false}
        onRegenerateArtifact={onRegenerateArtifact}
        onReplaceArtifact={onReplaceArtifact}
      />
    );
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Apri simulatore chiusura/i })).toBeInTheDocument();
  });

  test('keeps shared lifecycle state until an asynchronous discard succeeds', async () => {
    const user = userEvent.setup();
    let rejectDiscard: ((reason?: unknown) => void) | undefined;
    const pendingDiscard = new Promise<void>((_resolve, reject) => {
      rejectDiscard = reject;
    });
    const discardRequest = vi
      .fn()
      .mockImplementationOnce(() => pendingDiscard)
      .mockResolvedValue(undefined);
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const MultiSurfaceArtifacts = () => {
      const [hasDraft, setHasDraft] = useState(true);
      const [states, setStates] = useState<ChatArtifactRegenerationStates>({
        [htmlArtifact.summary.id]: 'succeeded',
      });
      const regenerationLifecycle = {
        replacementSourceArtifactIds: new Set(hasDraft ? [htmlArtifact.summary.id] : []),
        setStates,
        states,
      };
      const handleDiscard = async (request: { artifactId: string }) => {
        await discardRequest(request);
        setHasDraft(false);
      };

      return (
        <>
          <ChatArtifactRenderer
            artifacts={[htmlArtifact]}
            isDarkMode={false}
            regenerationLifecycle={regenerationLifecycle}
          />
          {hasDraft ? (
            <ChatArtifactRenderer
              artifacts={[replacementDraftArtifact]}
              isDarkMode={false}
              onDiscardArtifact={handleDiscard}
              regenerationLifecycle={regenerationLifecycle}
            />
          ) : null}
        </>
      );
    };

    render(<MultiSurfaceArtifacts />);
    expect(screen.queryByRole('button', { name: /Apri simulatore chiusura$/i })).toBeNull();
    await user.click(screen.getByRole('button', { name: /Apri simulatore chiusura rivisto/i }));
    await user.click(screen.getByRole('button', { name: /Scarta artefatto/i }));

    expect(
      screen.getByRole('dialog', { name: /simulatore chiusura rivisto/i })
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Apri simulatore chiusura$/i })).toBeNull();

    await act(async () => {
      rejectDiscard?.(new Error('discard failed'));
      await pendingDiscard.catch(() => undefined);
    });
    const actionFailureMessage = await screen.findByText(
      'Operazione non riuscita. L artefatto non e stato modificato.'
    );
    const actionFailureFeedback = actionFailureMessage.parentElement;
    expect(actionFailureFeedback).toHaveClass('bg-red-50', 'text-red-700');
    expect(actionFailureFeedback?.querySelector('.lucide-triangle-alert')).toBeInTheDocument();
    expect(
      screen.getByRole('dialog', { name: /simulatore chiusura rivisto/i })
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Apri simulatore chiusura$/i })).toBeNull();

    await user.click(screen.getByRole('button', { name: /Scarta artefatto/i }));
    expect(
      await screen.findByRole('button', { name: /Apri simulatore chiusura$/i })
    ).toBeInTheDocument();
    expect(screen.queryByText('Nuova bozza pronta.')).toBeNull();
    expect(discardRequest).toHaveBeenCalledTimes(2);
    consoleErrorSpy.mockRestore();
  });

  test('reports a failed regeneration without claiming that a new draft was created', async () => {
    const user = userEvent.setup();
    const onRegenerateArtifact = vi.fn().mockResolvedValue(false);
    render(
      <ChatArtifactRenderer
        artifacts={[htmlArtifact]}
        isDarkMode={false}
        onRegenerateArtifact={onRegenerateArtifact}
      />
    );

    await user.click(screen.getByRole('button', { name: /Apri simulatore chiusura/i }));
    await user.click(screen.getByRole('button', { name: /Rigenera artefatto/i }));
    const dialog = screen.getByRole('dialog', { name: /simulatore chiusura/i });
    await user.type(
      within(dialog).getByLabelText(/Istruzioni rigenerazione/i),
      'Correggi il widget.'
    );
    await user.click(within(dialog).getByRole('button', { name: /Conferma rigenerazione/i }));

    expect(screen.queryByRole('dialog', { name: /simulatore chiusura/i })).not.toBeInTheDocument();
    expect(
      await screen.findByText('Rigenerazione fallita. La bozza precedente non e stata modificata.')
    ).toBeInTheDocument();
    expect(screen.queryByText('Rigenerazione richiesta.')).toBeNull();
    expect(screen.getByRole('button', { name: /Apri simulatore chiusura/i })).toBeInTheDocument();
  });

  test('shows local feedback when discarding and saving artifacts', async () => {
    const user = userEvent.setup();
    const onDiscardArtifact = vi.fn();
    const onSaveArtifact = vi.fn().mockResolvedValue(undefined);
    render(
      <ChatArtifactRenderer
        artifacts={[htmlArtifact]}
        isDarkMode={false}
        onDiscardArtifact={onDiscardArtifact}
        onSaveArtifact={onSaveArtifact}
      />
    );

    await user.click(screen.getByRole('button', { name: /Apri simulatore chiusura/i }));
    await user.click(screen.getByRole('button', { name: /Scarta artefatto/i }));

    expect(onDiscardArtifact).toHaveBeenCalledWith({ artifactId: htmlArtifact.summary.id });
    expect(screen.getByText('Artefatto scartato.')).toBeInTheDocument();

    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: /Apri simulatore chiusura/i }));
    await user.click(screen.getByRole('button', { name: /Salva artefatto nella lezione/i }));

    expect(onSaveArtifact).toHaveBeenCalledWith({ artifactId: htmlArtifact.summary.id });
    expect(await screen.findByText('Salvato.')).toBeInTheDocument();
  });

  test('shows replace action for replacement drafts', async () => {
    const user = userEvent.setup();
    const onReplaceArtifact = vi.fn();
    render(
      <ChatArtifactRenderer
        artifacts={[replacementDraftArtifact]}
        isDarkMode={false}
        onReplaceArtifact={onReplaceArtifact}
      />
    );

    await user.click(screen.getByRole('button', { name: /Apri simulatore chiusura rivisto/i }));
    await user.click(screen.getByRole('button', { name: /Sostituisci artefatto/i }));

    expect(onReplaceArtifact).toHaveBeenCalledWith({
      artifactId: replacementDraftArtifact.summary.id,
      replacementOfArtifactId: htmlArtifact.summary.id,
    });
  });

  test('renders a replacement draft in place of its source artifact', () => {
    render(
      <ChatArtifactRenderer
        artifacts={[htmlArtifact, replacementDraftArtifact]}
        isDarkMode={false}
      />
    );

    expect(
      screen.queryByRole('button', { name: /Apri simulatore chiusura$/i })
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Apri simulatore chiusura rivisto/i })
    ).toBeInTheDocument();
  });

  test('keeps only the latest replacement draft for one source artifact', () => {
    render(
      <ChatArtifactRenderer
        artifacts={[htmlArtifact, latestReplacementDraftArtifact, replacementDraftArtifact]}
        isDarkMode={false}
      />
    );

    expect(
      screen.queryByRole('button', { name: /Apri simulatore chiusura rivisto/i })
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /Apri simulatore chiusura definitivo/i })
    ).toBeInTheDocument();
  });
});
