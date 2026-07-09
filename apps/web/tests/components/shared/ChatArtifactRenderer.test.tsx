// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';

import ChatArtifactRenderer from '../../../components/shared/ChatArtifactRenderer.tsx';
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
    id: 'visual-draft-3',
    title: 'simulatore_chiusura_rivisto',
  },
};

describe('ChatArtifactRenderer', () => {
  test('renders image thumbnails and chip-only interactive artifacts', () => {
    render(<ChatArtifactRenderer artifacts={[pdfArtifact, htmlArtifact]} isDarkMode={false} />);

    expect(screen.getByRole('img', { name: /Schema ER/i })).toBeInTheDocument();
    expect(screen.getByText('simulatore chiusura')).toBeInTheDocument();
    expect(screen.getByText(/Interattivo/i)).toBeInTheDocument();
  });

  test('opens and closes a responsive artifact overlay', async () => {
    const user = userEvent.setup();
    render(<ChatArtifactRenderer artifacts={[pdfArtifact]} isDarkMode={false} />);

    await user.click(screen.getByRole('button', { name: /Apri Schema ER/i }));

    const dialog = screen.getByRole('dialog', { name: /Schema ER/i });
    expect(dialog).toBeInTheDocument();
    expect(dialog.parentElement).toHaveClass('z-[130]');
    expect(dialog.parentElement?.parentElement).toBe(document.body);
    expect(within(dialog).getByRole('img', { name: /Schema ER/i })).toBeInTheDocument();

    await user.keyboard('{Escape}');

    expect(screen.queryByRole('dialog', { name: /Schema ER/i })).not.toBeInTheDocument();
  });

  test('renders visual overlays without the inline article spacing', async () => {
    const user = userEvent.setup();
    render(<ChatArtifactRenderer artifacts={[htmlArtifact]} isDarkMode={true} />);

    await user.click(screen.getByRole('button', { name: /Apri simulatore chiusura/i }));

    const dialog = screen.getByRole('dialog', { name: /simulatore chiusura/i });
    expect(within(dialog).getByTitle('simulatore chiusura').closest('figure')).toHaveClass('my-0');
  });

  test('requires revision instructions before regenerating an artifact', async () => {
    const user = userEvent.setup();
    const onRegenerateArtifact = vi.fn().mockResolvedValue(true);
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
    const submitButton = within(dialog).getByRole('button', { name: /Conferma rigenerazione/i });
    expect(within(dialog).getByLabelText(/Istruzioni rigenerazione/i)).toBeInTheDocument();
    expect(submitButton).toBeDisabled();

    await user.type(
      within(dialog).getByLabelText(/Istruzioni rigenerazione/i),
      'Rendilo piu sintetico e leggibile.'
    );
    await user.click(submitButton);

    expect(onRegenerateArtifact).toHaveBeenCalledWith({
      artifactId: htmlArtifact.summary.id,
      instructions: 'Rendilo piu sintetico e leggibile.',
    });
    expect(await screen.findByText('Rigenerazione richiesta.')).toBeInTheDocument();
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

    expect(
      await screen.findByText('Rigenerazione fallita. La bozza precedente non e stata modificata.')
    ).toBeInTheDocument();
    expect(screen.queryByText('Rigenerazione richiesta.')).toBeNull();
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
    await user.click(screen.getByRole('button', { name: /Salva artefatto nelle note/i }));

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
});
