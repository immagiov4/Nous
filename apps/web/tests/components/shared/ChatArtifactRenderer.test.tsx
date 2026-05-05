// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test } from 'vitest';

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
    expect(within(dialog).getByRole('img', { name: /Schema ER/i })).toBeInTheDocument();

    await user.keyboard('{Escape}');

    expect(screen.queryByRole('dialog', { name: /Schema ER/i })).not.toBeInTheDocument();
  });
});
