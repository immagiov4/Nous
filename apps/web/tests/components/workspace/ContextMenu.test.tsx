// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import ContextMenu from '../../../components/workspace/ContextMenu.tsx';
import type { LearningArtifactRenderPayload } from '../../../types.ts';

vi.mock('../../../components/shared/SpeechInputButton.tsx', async importOriginal => {
  const actual =
    await importOriginal<typeof import('../../../components/shared/SpeechInputButton.tsx')>();

  return {
    ...actual,
    default: ({
      disabled,
      onTranscription,
    }: {
      disabled?: boolean;
      onTranscription: (text: string) => void;
    }) => (
      <button
        type="button"
        disabled={disabled}
        aria-label="Dettatura test"
        onClick={() => onTranscription('testo trascritto')}
      >
        Mic
      </button>
    ),
  };
});

const buildProps = () => ({
  anchorX: 240,
  anchorY: 180,
  isLoading: false,
  horizontalBounds: undefined as { left: number; right: number } | undefined,
  onAsk: vi.fn(),
  onClose: vi.fn(),
  onCreateLesson: vi.fn(),
  onDeleteAnnotation: vi.fn(),
  onHighlight: vi.fn(),
  onSaveNote: vi.fn(),
  placement: 'desktop-floating' as 'desktop-floating' | 'mobile-sheet',
  selectedText: 'Testo selezionato molto importante',
  type: 'selection' as const,
});

const annotationArtifact: LearningArtifactRenderPayload = {
  summary: {
    id: 'project-1:section-1:generated-visual:visual-draft-1',
    kind: 'generated-visual',
    lessonId: 'section-1',
    lessonTitle: 'Lezione test',
    previewMode: 'chip-only',
    projectId: 'project-1',
    projectTitle: 'Corso test',
    title: 'Mappa salvata',
  },
  visual: {
    code: '<div>Mappa salvata</div>',
    createdAt: '2026-05-05T10:00:00.000Z',
    id: 'visual-draft-1',
    kind: 'html',
    title: 'Mappa salvata',
  },
};

describe('ContextMenu', () => {
  beforeEach(() => {
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => {
      callback(0);
      return 1;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('submits a desktop question with trimmed input', async () => {
    const user = userEvent.setup();
    const props = buildProps();

    render(<ContextMenu {...props} />);

    await user.type(screen.getByPlaceholderText(/Chiedi a Nous/i), '   Come funziona?   ');
    await user.click(screen.getByRole('button', { name: /Invia domanda/i }));

    expect(props.onAsk).toHaveBeenCalledTimes(1);
    expect(props.onAsk).toHaveBeenCalledWith('Come funziona?');
    expect(props.onClose).not.toHaveBeenCalled();
  });

  test('submits a whole-lesson question without selection-only actions', async () => {
    const user = userEvent.setup();
    const props = {
      ...buildProps(),
      selectedText: '',
      type: 'lesson' as const,
    };

    render(<ContextMenu {...props} />);

    expect(screen.queryByTitle(/Evidenzia il testo selezionato/i)).not.toBeInTheDocument();
    expect(screen.queryByTitle(/Aggiungi una nota a questo passaggio/i)).not.toBeInTheDocument();
    expect(
      screen.queryByTitle(/Crea una nuova lezione dedicata a questo punto/i)
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Apri menu' })).not.toBeInTheDocument();

    await user.type(screen.getByPlaceholderText(/Chiedi su tutta la lezione/i), 'Fammi una mappa');
    await user.click(screen.getByRole('button', { name: /Invia domanda/i }));

    expect(props.onAsk).toHaveBeenCalledWith('Fammi una mappa');
  });

  test('submits on mobile only after closing the sheet', async () => {
    const user = userEvent.setup();
    const callLog: string[] = [];
    const props = buildProps();
    props.placement = 'mobile-sheet';
    props.onAsk = vi.fn(() => {
      callLog.push('ask');
    });
    props.onClose = vi.fn(() => {
      callLog.push('close');
    });

    render(<ContextMenu {...props} />);

    expect(screen.getByRole('button', { name: 'Dettatura test' })).toBeInTheDocument();
    await user.type(screen.getByPlaceholderText(/Chiedi a Nous/i), 'Domanda mobile');
    await user.click(screen.getByRole('button', { name: /Invia domanda/i }));

    expect(props.onClose).toHaveBeenCalledTimes(1);
    expect(props.onAsk).toHaveBeenCalledTimes(1);
    expect(callLog).toEqual(['close', 'ask']);
  });

  test('blocks duplicate mobile ask interactions until the lock expires', async () => {
    vi.useFakeTimers();
    const props = buildProps();
    props.placement = 'mobile-sheet';

    render(<ContextMenu {...props} />);

    fireEvent.change(screen.getByPlaceholderText(/Chiedi a Nous/i), {
      target: { value: 'Domanda con lock' },
    });
    const askButton = screen.getByRole('button', { name: /Invia domanda/i });

    fireEvent.pointerDown(askButton);
    fireEvent.click(askButton);

    expect(props.onAsk).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(401);
    fireEvent.click(askButton);

    expect(props.onAsk).toHaveBeenCalledTimes(2);
  });

  test('opens, cancels and confirms lesson creation', async () => {
    const user = userEvent.setup();
    const props = buildProps();

    render(<ContextMenu {...props} />);

    await user.type(screen.getByPlaceholderText(/Chiedi a Nous/i), 'Approfondisci il punto');

    const moreActionsButton = screen.getByRole('button', { name: 'Apri menu' });
    await user.click(moreActionsButton);
    await user.click(screen.getByRole('menuitem', { name: 'Crea lezione' }));

    const confirmationPanel = screen
      .getByText(/Vuoi creare una nuova lezione da questa selezione/i)
      .closest('div[aria-hidden]');

    expect(confirmationPanel).toHaveAttribute('aria-hidden', 'false');
    expect(screen.getAllByText(/Testo selezionato molto importante/i).length).toBeGreaterThan(0);

    await user.click(screen.getByRole('button', { name: 'Annulla' }));
    expect(confirmationPanel).toHaveAttribute('aria-hidden', 'true');

    await user.click(moreActionsButton);
    await user.click(screen.getByRole('menuitem', { name: 'Crea lezione' }));
    await user.click(screen.getByRole('button', { name: 'Procedi' }));

    expect(props.onCreateLesson).toHaveBeenCalledWith('Approfondisci il punto');
  });

  test('closes on escape and disables actions while loading', () => {
    const props = buildProps();
    props.isLoading = true;

    render(<ContextMenu {...props} />);

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(props.onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: /Invia domanda/i })).not.toBeInTheDocument();
    expect(screen.getByTitle(/Evidenzia il testo selezionato/i)).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Apri menu' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Dettatura test' })).toBeDisabled();
  });

  test('shows voice on empty desktop input and switches to send after transcription', async () => {
    const user = userEvent.setup();
    const props = buildProps();

    render(<ContextMenu {...props} />);

    const input = screen.getByPlaceholderText(/Chiedi a Nous/i);
    await user.click(screen.getByRole('button', { name: 'Dettatura test' }));

    expect(input).toHaveValue('testo trascritto');
    expect(screen.queryByRole('button', { name: 'Dettatura test' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Invia domanda/i })).toBeInTheDocument();
    expect(props.onAsk).not.toHaveBeenCalled();
  });

  test('renders rare actions in a portal and closes that submenu before the parent', async () => {
    const user = userEvent.setup();
    const props = buildProps();
    const portalContainer = document.createElement('div');
    document.body.append(portalContainer);

    render(<ContextMenu {...props} artifactPortalContainer={portalContainer} />);

    const moreActionsButton = screen.getByRole('button', { name: 'Apri menu' });
    await user.click(moreActionsButton);

    const submenu = screen.getByRole('menu', { name: 'Apri menu' });
    const createLessonItem = screen.getByRole('menuitem', { name: 'Crea lezione' });
    expect(submenu.parentElement).toBe(portalContainer);
    expect(createLessonItem).toHaveFocus();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('menu', { name: 'Apri menu' })).not.toBeInTheDocument();
    expect(props.onClose).not.toHaveBeenCalled();
    expect(moreActionsButton).toHaveFocus();

    await user.click(moreActionsButton);
    fireEvent.pointerDown(screen.getByPlaceholderText(/Chiedi a Nous/i));
    expect(screen.queryByRole('menu', { name: 'Apri menu' })).not.toBeInTheDocument();
    expect(props.onClose).not.toHaveBeenCalled();
  });

  test('keeps the note panel anchored while opening the rare-actions menu', async () => {
    const user = userEvent.setup();

    render(<ContextMenu {...buildProps()} />);

    await user.click(screen.getByTitle(/Aggiungi una nota a questo passaggio/i));
    const noteInput = screen.getByPlaceholderText(
      /Scrivi la nota che vuoi lasciare su questo passaggio/i
    );
    await user.click(screen.getByRole('button', { name: 'Apri menu' }));

    expect(noteInput).toBeVisible();
    expect(screen.getByRole('menuitem', { name: 'Crea lezione' })).toBeInTheDocument();
  });

  test('opens the rare-actions portal and lesson confirmation from the mobile sheet', async () => {
    const user = userEvent.setup();
    const props = buildProps();
    props.placement = 'mobile-sheet';

    render(<ContextMenu {...props} />);

    await user.click(screen.getByRole('button', { name: 'Apri menu' }));
    await user.click(screen.getByRole('menuitem', { name: 'Crea lezione' }));

    expect(
      screen
        .getByText(/Vuoi creare una nuova lezione da questa selezione/i)
        .closest('[aria-hidden]')
    ).toHaveAttribute('aria-hidden', 'false');
  });

  test('keeps the desktop transform origin stable across rerenders', () => {
    const props = buildProps();
    const { container, rerender } = render(<ContextMenu {...props} anchorX={240} anchorY={180} />);

    const surface = container.firstElementChild as HTMLElement;
    const initialTransformOrigin = surface.style.transformOrigin;

    rerender(<ContextMenu {...props} anchorX={320} anchorY={220} />);

    expect(surface.style.transformOrigin).toBe(initialTransformOrigin);
  });

  test('bounds the desktop note panel to the remaining viewport height', async () => {
    const user = userEvent.setup();
    const { container } = render(<ContextMenu {...buildProps()} />);
    const surface = container.firstElementChild as HTMLElement;
    const initialTop = surface.style.top;
    const initialBottom = surface.style.bottom;

    await user.click(screen.getByTitle(/Aggiungi una nota a questo passaggio/i));

    const noteInput = screen.getByPlaceholderText(
      /Scrivi la nota che vuoi lasciare su questo passaggio/i
    );
    const noteMaxHeight = Number.parseFloat(
      surface.style.getPropertyValue('--context-menu-note-max-height')
    );
    const top = Number.parseFloat(surface.style.top);

    expect(noteMaxHeight).toBeGreaterThan(0);
    expect(top + noteMaxHeight).toBeLessThanOrEqual(window.innerHeight);
    expect(surface.style.top).toBe(initialTop);
    expect(surface.style.bottom).toBe(initialBottom);
    expect(noteInput).toHaveAttribute('rows', '5');
  });

  test('opens the note editor and saves a note from a new selection', async () => {
    const user = userEvent.setup();
    const props = buildProps();

    render(<ContextMenu {...props} />);

    await user.click(screen.getByTitle(/Aggiungi una nota a questo passaggio/i));
    await user.type(
      screen.getByPlaceholderText(/Scrivi la nota che vuoi lasciare su questo passaggio/i),
      'Ricordati di rivedere questo concetto'
    );
    await user.click(screen.getByRole('button', { name: /Salva nota/i }));

    expect(props.onSaveNote).toHaveBeenCalledWith('Ricordati di rivedere questo concetto', []);
  });

  test('can attach an extra artifact while creating a note from a new selection', async () => {
    const user = userEvent.setup();
    const props = {
      ...buildProps(),
      artifactPayloads: [annotationArtifact],
    };

    render(<ContextMenu {...props} />);

    await user.click(screen.getByTitle(/Aggiungi una nota a questo passaggio/i));
    await user.click(screen.getByRole('button', { name: /Allega dagli artefatti/i }));
    await user.click(screen.getByRole('menuitem', { name: /Allega Mappa salvata alla nota/i }));

    expect(screen.getByRole('button', { name: /Apri Mappa salvata/i })).toBeInTheDocument();

    await user.type(
      screen.getByPlaceholderText(/Scrivi la nota che vuoi lasciare su questo passaggio/i),
      'Nota con artefatto'
    );
    await user.click(screen.getByRole('button', { name: /Salva nota/i }));

    expect(props.onSaveNote).toHaveBeenCalledWith('Nota con artefatto', [
      {
        artifactId: 'project-1:section-1:generated-visual:visual-draft-1',
        kind: 'generated-visual',
        title: 'Mappa salvata',
      },
    ]);
  });

  test('can save an attached artifact without note text', async () => {
    const user = userEvent.setup();
    const props = {
      ...buildProps(),
      artifactPayloads: [annotationArtifact],
    };

    render(<ContextMenu {...props} />);

    await user.click(screen.getByTitle(/Aggiungi una nota a questo passaggio/i));
    await user.click(screen.getByRole('button', { name: /Allega dagli artefatti/i }));
    await user.click(screen.getByRole('menuitem', { name: /Allega Mappa salvata alla nota/i }));
    await user.click(screen.getByRole('button', { name: /Salva nota/i }));

    expect(props.onSaveNote).toHaveBeenCalledWith('', [
      {
        artifactId: 'project-1:section-1:generated-visual:visual-draft-1',
        kind: 'generated-visual',
        title: 'Mappa salvata',
      },
    ]);
  });

  test('offers generated visuals but excludes images extracted from the source', async () => {
    const user = userEvent.setup();
    const savedGeneratedArtifact: LearningArtifactRenderPayload = {
      ...annotationArtifact,
      summary: {
        ...annotationArtifact.summary,
        id: 'project-1:section-1:generated-visual:visual-001',
      },
      visual: { ...annotationArtifact.visual, id: 'visual-001' },
    };
    const sourceImageArtifact: LearningArtifactRenderPayload = {
      summary: {
        ...annotationArtifact.summary,
        id: 'project-1:section-1:pdf-image:image-001',
        kind: 'pdf-image',
        title: 'Figura dal libro',
      },
      image: {
        id: 'image-001',
        mimeType: 'image/png',
        dataUrl: 'data:image/png;base64,AA==',
        textBefore: '',
        textAfter: '',
        sourceOrder: 1,
      },
    };

    render(
      <ContextMenu
        {...buildProps()}
        artifactPayloads={[sourceImageArtifact, savedGeneratedArtifact]}
      />
    );

    await user.click(screen.getByTitle(/Aggiungi una nota a questo passaggio/i));
    await user.click(screen.getByRole('button', { name: /Allega dagli artefatti/i }));

    expect(screen.getByRole('menuitem', { name: /Allega Mappa salvata/i })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /Figura dal libro/i })).not.toBeInTheDocument();
  });

  test('does not show remove inside the note editor for a highlight without a saved note', async () => {
    const user = userEvent.setup();
    const props = {
      ...buildProps(),
      annotationNote: '',
      type: 'annotation' as const,
    };

    render(<ContextMenu {...props} />);

    await user.click(screen.getByTitle(/Aggiungi o modifica una nota/i));

    expect(screen.getByRole('button', { name: 'Annulla' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Salva' })).toBeInTheDocument();
    expect(screen.queryByText('Rimuovi')).not.toBeInTheDocument();
  });

  test('opens annotation clicks as a selection toolbar before editing notes', async () => {
    const user = userEvent.setup();
    const props = {
      ...buildProps(),
      annotationNote:
        'Formula **chiave**: $y(t)=x$\n\n| Simbolo | Significato |\n| --- | --- |\n| $x$ | stato |',
      type: 'annotation' as const,
    };

    const { container } = render(<ContextMenu {...props} />);

    expect(
      screen.queryByPlaceholderText(/Scrivi, aggiorna o svuota la nota/i)
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(/Nota associata al passaggio/i).closest('[aria-hidden]')
    ).toHaveAttribute('aria-hidden', 'false');
    expect(screen.getByPlaceholderText(/Chiedi a Nous/i)).toBeInTheDocument();
    expect(screen.queryByTitle(/Aggiungi o modifica una nota/i)).not.toBeInTheDocument();
    expect(screen.getByTitle('Rimuovi evidenziazione')).toBeInTheDocument();
    expect(container.querySelector('strong')?.textContent).toBe('chiave');
    expect(container.querySelector('.katex')).not.toBeNull();
    expect(screen.getByRole('table')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Modifica' }));

    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    const textarea = screen.getByPlaceholderText(/Scrivi, aggiorna o svuota la nota/i);
    expect(textarea).toHaveValue(props.annotationNote);
    await user.clear(textarea);
    await user.click(screen.getByRole('button', { name: 'Salva' }));

    expect(props.onSaveNote).toHaveBeenCalledWith('', []);
  });

  test('renders saved annotation artifacts in preview mode', () => {
    const onDetachArtifactFromAnnotation = vi.fn();
    const props = {
      ...buildProps(),
      annotationArtifactRefs: [
        {
          artifactId: 'project-1:section-1:generated-visual:visual-draft-1',
          kind: 'generated-visual' as const,
          title: 'Mappa salvata',
        },
      ],
      annotationNote: '',
      artifactPayloads: [annotationArtifact],
      onDetachArtifactFromAnnotation,
      type: 'annotation' as const,
    };

    render(<ContextMenu {...props} />);

    expect(screen.getByRole('button', { name: /Apri Mappa salvata/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Rimuovi Mappa salvata dalla nota/i }));
    expect(onDetachArtifactFromAnnotation).toHaveBeenCalledWith(
      'project-1:section-1:generated-visual:visual-draft-1'
    );
    expect(screen.queryByRole('button', { name: /Apri Mappa salvata/i })).not.toBeInTheDocument();
  });

  test('applies a deterministic scroll position to an annotation preview', () => {
    const props = {
      ...buildProps(),
      annotationNote: 'Una nota abbastanza lunga da poter essere fatta scorrere nel video.',
      notePreviewScrollTopOverride: 0,
      type: 'annotation' as const,
    };

    const { container, rerender } = render(<ContextMenu {...props} />);
    const preview = container.querySelector<HTMLElement>(
      '[data-context-menu-target="note-preview-scroll"]'
    );
    const topFade = container.querySelector<HTMLElement>(
      '[data-context-menu-target="note-preview-top-fade"]'
    );

    expect(preview?.scrollTop).toBe(0);
    expect(topFade).toHaveStyle({ opacity: '0' });

    rerender(<ContextMenu {...props} notePreviewScrollTopOverride={72} />);

    expect(preview?.scrollTop).toBe(72);
    expect(topFade).toHaveStyle({ opacity: '1' });
  });

  test('can attach an existing artifact to an annotation note', () => {
    const onAttachArtifactToAnnotation = vi.fn();
    const props = {
      ...buildProps(),
      annotationNote: '',
      artifactPayloads: [annotationArtifact],
      onAttachArtifactToAnnotation,
      type: 'annotation' as const,
    };

    render(<ContextMenu {...props} />);

    fireEvent.click(screen.getByTitle(/Aggiungi o modifica una nota/i));
    fireEvent.click(screen.getByRole('button', { name: /Allega dagli artefatti/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Allega Mappa salvata alla nota/i }));

    expect(onAttachArtifactToAnnotation).toHaveBeenCalledWith({
      artifactId: 'project-1:section-1:generated-visual:visual-draft-1',
      kind: 'generated-visual',
      title: 'Mappa salvata',
    });
    expect(screen.getByRole('button', { name: /Apri Mappa salvata/i })).toBeInTheDocument();
  });

  test('allows removing an annotation directly from preview mode', async () => {
    const user = userEvent.setup();
    const props = {
      ...buildProps(),
      annotationNote: 'Nota gia presente',
      type: 'annotation' as const,
    };

    render(<ContextMenu {...props} />);

    await user.click(screen.getByTitle('Rimuovi evidenziazione'));
    expect(props.onDeleteAnnotation).toHaveBeenCalledTimes(1);
  });

  test('allows removing a highlight-only annotation even when no note exists yet', async () => {
    const user = userEvent.setup();
    const props = {
      ...buildProps(),
      annotationNote: '',
      type: 'annotation' as const,
    };

    render(<ContextMenu {...props} />);

    await user.click(screen.getByTitle('Rimuovi evidenziazione'));
    expect(props.onDeleteAnnotation).toHaveBeenCalledTimes(1);
  });

  test('submits a question from an annotation toolbar', async () => {
    const user = userEvent.setup();
    const props = {
      ...buildProps(),
      annotationNote: '',
      type: 'annotation' as const,
    };

    render(<ContextMenu {...props} />);

    await user.type(screen.getByPlaceholderText(/Chiedi a Nous/i), 'Fammi un esempio');
    await user.click(screen.getByRole('button', { name: /Invia domanda/i }));

    expect(props.onAsk).toHaveBeenCalledWith('Fammi un esempio');
  });

  test('keeps the desktop menu inside the reading column bounds', () => {
    const props = buildProps();
    props.anchorX = 410;
    props.horizontalBounds = {
      left: 384,
      right: 980,
    };

    const { container } = render(<ContextMenu {...props} />);
    const menuRoot = container.firstElementChild as HTMLElement | null;

    expect(menuRoot).not.toBeNull();
    expect(menuRoot?.style.left).toBe('396px');
  });
});
