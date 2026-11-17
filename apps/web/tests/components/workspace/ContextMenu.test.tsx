// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import ContextMenu from '../../../components/workspace/ContextMenu.tsx';
import type { LearningArtifactRenderPayload, LessonCreationBlockReason } from '../../../types.ts';

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
  lessonCreationBlockReason: null as LessonCreationBlockReason | null,
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
  test('retains only the saved note preview across modes and keeps editing independent', async () => {
    const user = userEvent.setup();
    const props = {
      ...buildProps(),
      type: 'annotation' as const,
      annotationNote: 'Nota **salvata**',
      artifactPayloads: [annotationArtifact],
      annotationArtifactRefs: [
        { artifactId: annotationArtifact.summary.id, kind: 'generated-visual' as const },
      ],
    };
    const { container, rerender } = render(<ContextMenu {...props} />);
    const preview = container.querySelector('[data-context-menu-target="note-preview"]');
    expect(preview).not.toBeNull();
    await user.click(screen.getByRole('button', { name: 'Chiedi a Nous' }));
    expect(preview).not.toBeVisible();
    expect(screen.getAllByRole('textbox')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /Apri Mappa salvata/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Nota' }));
    expect(container.querySelector('[data-context-menu-target="note-preview"]')).toBe(preview);
    expect(screen.getAllByRole('button', { name: /Apri Mappa salvata/ })).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Modifica' }));
    await user.type(screen.getByRole('textbox'), ' nuova bozza');
    expect(preview?.textContent).toContain('Nota salvata');
    expect(preview?.textContent).not.toContain('nuova bozza');
    expect(screen.getAllByRole('textbox')).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: /Apri Mappa salvata/ })).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Salva nota' }));
    expect(props.onSaveNote).toHaveBeenCalledWith(
      'Nota **salvata** nuova bozza',
      expect.any(Array)
    );
    rerender(<ContextMenu {...props} annotationNote="Nota aggiornata" />);
    expect(preview?.textContent).toContain('Nota aggiornata');
  });

  test('places mobile speech beside Ask text and keeps it out of the footer and Note', async () => {
    const user = userEvent.setup();
    render(<ContextMenu {...buildProps()} placement="mobile-sheet" />);
    const speech = screen.getByRole('button', { name: 'Dettatura test' });
    expect(speech.closest('.context-composer-field')).not.toBeNull();
    expect(speech.closest('footer')).toBeNull();
    await user.click(speech);
    expect(screen.getByRole('textbox')).toHaveValue('testo trascritto');
    await user.click(screen.getByRole('button', { name: 'Nota' }));
    expect(screen.queryByRole('button', { name: 'Dettatura test' })).not.toBeInTheDocument();
  });

  test('offers mobile Note discard in More and returns to the saved rendered note', async () => {
    const user = userEvent.setup();
    render(
      <ContextMenu
        {...buildProps()}
        placement="mobile-sheet"
        type="annotation"
        annotationNote="Nota **salvata**"
      />
    );
    await user.click(screen.getByRole('button', { name: 'Modifica' }));
    await user.type(screen.getByRole('textbox'), ' bozza da scartare');
    await user.click(screen.getByRole('button', { name: 'Apri menu' }));
    await user.click(screen.getByRole('menuitem', { name: 'Annulla' }));
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByText('salvata', { selector: 'strong' })).toBeInTheDocument();
    expect(screen.queryByText(/bozza da scartare/)).not.toBeInTheDocument();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  test('Cancel clears unsaved selection attachments while preserving the Ask draft', async () => {
    const user = userEvent.setup();
    render(
      <ContextMenu
        {...buildProps()}
        placement="mobile-sheet"
        artifactPayloads={[annotationArtifact]}
      />
    );
    await user.type(screen.getByRole('textbox'), 'Domanda da conservare');
    await user.click(screen.getByRole('button', { name: 'Nota' }));
    await user.type(screen.getByRole('textbox'), 'Bozza nota');
    await user.click(screen.getByRole('button', { name: 'Allega dagli artefatti' }));
    await user.click(screen.getByRole('menuitem', { name: /Allega Mappa salvata alla nota/ }));
    await user.click(screen.getByRole('button', { name: 'Apri menu' }));
    await user.click(screen.getByRole('menuitem', { name: 'Annulla' }));
    expect(screen.getByRole('textbox')).toHaveValue('Domanda da conservare');
    await user.click(screen.getByRole('button', { name: 'Nota' }));
    expect(screen.getByRole('textbox')).toHaveValue('');
    expect(screen.queryByRole('button', { name: 'Apri Mappa salvata' })).not.toBeInTheDocument();
  });

  test('More focuses enabled Cancel when lesson creation is blocked', async () => {
    const user = userEvent.setup();
    render(
      <ContextMenu
        {...buildProps()}
        placement="mobile-sheet"
        lessonCreationBlockReason="lesson-generation"
      />
    );
    await user.type(screen.getByRole('textbox'), 'Domanda da conservare');
    await user.click(screen.getByRole('button', { name: 'Nota' }));
    await user.type(screen.getByRole('textbox'), 'Bozza');
    await user.click(screen.getByRole('button', { name: 'Apri menu' }));
    expect(
      screen.getByRole('menuitem', { name: 'Attendi che la generazione in corso termini' })
    ).toBeDisabled();
    const cancel = screen.getByRole('menuitem', { name: 'Annulla' });
    await waitFor(() => expect(cancel).toHaveFocus());
    await user.keyboard('{Enter}');
    expect(screen.getByRole('textbox')).toHaveValue('Domanda da conservare');
  });

  test.each([
    'attach',
    'detach',
  ] as const)('Cancel preserves already-committed annotation %s refs', async operation => {
    const user = userEvent.setup();
    const onAttachArtifactToAnnotation = vi.fn();
    const onDetachArtifactFromAnnotation = vi.fn();
    render(
      <ContextMenu
        {...buildProps()}
        placement="mobile-sheet"
        type="annotation"
        annotationNote="Nota salvata"
        artifactPayloads={[annotationArtifact]}
        annotationArtifactRefs={
          operation === 'detach'
            ? [{ artifactId: annotationArtifact.summary.id, kind: 'generated-visual' }]
            : []
        }
        onAttachArtifactToAnnotation={onAttachArtifactToAnnotation}
        onDetachArtifactFromAnnotation={onDetachArtifactFromAnnotation}
      />
    );
    await user.click(screen.getByRole('button', { name: 'Modifica' }));
    if (operation === 'attach') {
      await user.click(screen.getByRole('button', { name: 'Allega dagli artefatti' }));
      await user.click(screen.getByRole('menuitem', { name: /Allega Mappa salvata alla nota/ }));
      expect(onAttachArtifactToAnnotation).toHaveBeenCalledOnce();
    } else {
      await user.click(screen.getByRole('button', { name: /Rimuovi Mappa salvata dalla nota/ }));
      expect(onDetachArtifactFromAnnotation).toHaveBeenCalledOnce();
    }
    await user.click(screen.getByRole('button', { name: 'Apri menu' }));
    await user.click(screen.getByRole('menuitem', { name: 'Annulla' }));
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryAllByRole('button', { name: 'Apri Mappa salvata' })).toHaveLength(
      operation === 'attach' ? 1 : 0
    );
  });

  test.each([
    'ask',
    'note',
  ] as const)('does not submit %s while IME composition commits Enter', async mode => {
    const user = userEvent.setup();
    const props = buildProps();
    render(<ContextMenu {...props} />);
    if (mode === 'note') await user.click(screen.getByRole('button', { name: 'Nota' }));
    const field = screen.getByRole('textbox');
    await user.type(field, 'Testo composto');
    fireEvent.keyDown(field, { key: 'Enter', isComposing: true, ctrlKey: mode === 'note' });
    expect(props.onAsk).not.toHaveBeenCalled();
    expect(props.onSaveNote).not.toHaveBeenCalled();
    expect(field).toHaveValue('Testo composto');
    fireEvent.keyDown(field, { key: 'Enter', isComposing: false, ctrlKey: mode === 'note' });
    expect(mode === 'note' ? props.onSaveNote : props.onAsk).toHaveBeenCalledOnce();
  });

  test.each([
    'selection',
    'annotation',
  ] as const)('puts mobile %s highlight in Ask footer between More and Send, never in Note', async type => {
    const user = userEvent.setup();
    const props = { ...buildProps(), placement: 'mobile-sheet' as const, type };
    render(<ContextMenu {...props} askInputValue="Domanda" />);
    await user.click(screen.getByRole('button', { name: 'Chiedi a Nous' }));
    const label = type === 'annotation' ? 'Rimuovi evidenziazione' : 'Evidenzia selezione';
    const highlight = screen.getByRole('button', { name: label });
    const more = screen.getByRole('button', { name: 'Apri menu' });
    const send = screen.getByRole('button', { name: 'Invia domanda' });
    const actions = highlight.closest('.context-composer-actions');
    if (!actions) throw new Error('Expected footer actions');
    expect([...actions.querySelectorAll('button')].slice(-3)).toEqual([more, highlight, send]);
    more.focus();
    await user.tab();
    expect(highlight).toHaveFocus();
    await user.tab();
    expect(send).toHaveFocus();
    await user.click(more);
    expect(screen.queryByRole('menuitem', { name: label })).not.toBeInTheDocument();
    await user.keyboard('{Escape}');
    highlight.focus();
    await user.keyboard(' ');
    expect(
      type === 'annotation' ? props.onDeleteAnnotation : props.onHighlight
    ).toHaveBeenCalledOnce();
    await user.click(screen.getByRole('button', { name: 'Nota' }));
    expect(screen.queryByRole('button', { name: label })).not.toBeInTheDocument();
    await user.click(more);
    expect(screen.queryByRole('menuitem', { name: label })).not.toBeInTheDocument();
  });

  test.each([
    'desktop-floating',
    'mobile-sheet',
  ] as const)('uses one %s composer with independent question and note drafts', async placement => {
    const user = userEvent.setup();
    const props = { ...buildProps(), placement, artifactPayloads: [annotationArtifact] };
    render(<ContextMenu {...props} />);
    await user.type(screen.getByRole('textbox'), 'Spiega questo collegamento');
    await user.click(screen.getByRole('button', { name: 'Nota' }));
    expect(screen.getAllByRole('textbox')).toHaveLength(1);
    await user.type(screen.getByRole('textbox'), 'Un esempio che conosco');
    await user.click(screen.getByRole('button', { name: /Allega dagli artefatti/ }));
    await user.click(screen.getByRole('menuitem', { name: /Allega Mappa salvata alla nota/ }));
    expect(screen.getByRole('textbox')).toHaveFocus();
    await user.click(screen.getByRole('button', { name: 'Chiedi a Nous' }));
    expect(screen.getByRole('textbox')).toHaveValue('Spiega questo collegamento');
    expect(screen.getByRole('button', { name: 'Chiedi a Nous' })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    await user.click(screen.getByRole('button', { name: 'Nota' }));
    expect(screen.getByRole('textbox')).toHaveValue('Un esempio che conosco');
    expect(screen.getByRole('button', { name: /Apri Mappa salvata/ })).toBeInTheDocument();
    const save = screen.getByRole('button', { name: 'Salva nota' });
    const more = screen.getByRole('button', { name: 'Apri menu' });
    expect(save.closest('form')).toBe(more.closest('form'));
    await user.click(save);
    expect(props.onSaveNote).toHaveBeenCalledWith('Un esempio che conosco', [
      {
        artifactId: annotationArtifact.summary.id,
        kind: 'generated-visual',
        title: annotationArtifact.summary.title,
      },
    ]);
  });

  test.each([
    'desktop-floating',
    'mobile-sheet',
  ] as const)('opens a saved %s annotation in note preview and keeps asking separate', async placement => {
    const user = userEvent.setup();
    const props = {
      ...buildProps(),
      placement,
      type: 'annotation' as const,
      annotationNote: 'La mia nota **salvata**',
    };
    const { rerender } = render(<ContextMenu {...props} />);
    expect(screen.getByRole('button', { name: 'Nota' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('salvata', { selector: 'strong' })).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Chiedi a Nous' }));
    await user.type(screen.getByRole('textbox'), 'Parti dalla mia nota');
    await user.click(screen.getByRole('button', { name: 'Nota' }));
    await user.click(screen.getByRole('button', { name: 'Modifica' }));
    expect(screen.getByRole('textbox')).toHaveValue(props.annotationNote);
    rerender(<ContextMenu {...props} annotationNote="Nota appena riaperta" />);
    expect(screen.getByRole('button', { name: 'Nota' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Nota appena riaperta')).toBeInTheDocument();
  });

  test.each(
    (['desktop-floating', 'mobile-sheet'] as const).flatMap(placement =>
      [true, false].map(persisted => ({ placement, persisted }))
    )
  )('freezes a pending $placement note until acknowledgement (success=$persisted)', async ({
    placement,
    persisted,
  }) => {
    const user = userEvent.setup();
    let release!: () => void;
    const pending = new Promise<void>(resolve => {
      release = resolve;
    });
    const props = { ...buildProps(), placement, artifactPayloads: [annotationArtifact] };
    props.onSaveNote.mockImplementation(async () => {
      await pending;
      if (persisted) props.onClose();
    });
    render(<ContextMenu {...props} />);
    await user.click(screen.getByRole('button', { name: 'Nota' }));
    const note = screen.getByPlaceholderText(
      'Scrivi la nota che vuoi lasciare su questo passaggio...'
    );
    note.scrollIntoView = vi.fn();
    await user.type(note, 'Save this exact draft');
    const save = screen.getByRole('button', { name: 'Salva nota' });
    await user.click(save);
    expect(note).toBeDisabled();
    expect(save).toBeDisabled();
    expect(save).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('button', { name: 'Nota' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Allega dagli artefatti' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Annulla' })).toBeDisabled();
    await user.type(note, ' must not be discarded');
    await user.click(save);
    expect(note).toHaveValue('Save this exact draft');
    expect(props.onSaveNote).toHaveBeenCalledOnce();
    expect(props.onClose).not.toHaveBeenCalled();
    await act(async () => {
      release();
      await pending;
    });
    expect(props.onClose).toHaveBeenCalledTimes(persisted ? 1 : 0);
    expect(note).toBeEnabled();
    expect(note).toHaveValue('Save this exact draft');
    if (!persisted) {
      await user.type(note, ' retained');
      expect(note).toHaveValue('Save this exact draft retained');
    }
  });

  test.each([
    false,
    true,
  ])('preserves playback input transitions on mobile=%s', isMobileViewport => {
    const props = { ...buildProps(), type: 'lesson' as const };
    const playbackComposer = {
      isMobileViewport,
      value: 'Domanda corrente',
      noteMode: false,
      onChange: vi.fn(),
      onToggleNote: vi.fn(),
      onSubmit: vi.fn(),
    };
    const { rerender } = render(<ContextMenu {...props} playbackComposer={playbackComposer} />);
    const input = screen.getByRole('textbox');
    expect(input.tagName).toBe('INPUT');
    expect(input).toHaveValue(playbackComposer.value);
    expect(input.parentElement).toHaveStyle({ height: '2.5rem' });
    expect(input.parentElement).toHaveClass(
      isMobileViewport ? 'transition-none' : 'transition-[height]'
    );
    fireEvent.change(input, { target: { value: 'Nuova domanda' } });
    expect(playbackComposer.onChange).toHaveBeenCalledWith('Nuova domanda');

    const noteComposer = { ...playbackComposer, value: 'Appunto corrente', noteMode: true };
    rerender(<ContextMenu {...props} playbackComposer={noteComposer} />);
    const note = screen.getByRole('textbox');
    expect(note.tagName).toBe('TEXTAREA');
    expect(note).toHaveValue(noteComposer.value);
    expect(note).toHaveAttribute('rows', '5');
    expect(note.parentElement).toHaveStyle({ height: 'calc(5lh + 1.25rem)' });
    fireEvent.change(note, { target: { value: 'Nuovo appunto' } });
    expect(playbackComposer.onChange).toHaveBeenCalledWith('Nuovo appunto');
    fireEvent.click(screen.getByRole('button', { name: 'Salva nota' }));
    expect(playbackComposer.onSubmit).toHaveBeenCalledOnce();

    rerender(<ContextMenu {...props} playbackComposer={{ ...noteComposer, listening: true }} />);
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    const listening = screen.getByRole('status');
    expect(listening).toHaveTextContent('Ti ascolto… rilascia Spazio per inviare');
    expect(listening.parentElement).toHaveStyle({ height: '2.5rem' });

    rerender(<ContextMenu {...props} playbackComposer={noteComposer} />);
    expect(screen.getByRole('textbox')).toHaveValue(noteComposer.value);
    expect(screen.getByRole('textbox').parentElement).toHaveStyle({
      height: 'calc(5lh + 1.25rem)',
    });
  });

  test.each([
    'desktop-floating',
    'mobile-sheet',
  ] as const)('keeps %s editing available while context-dependent actions wait', async placement => {
    const user = userEvent.setup();
    const props = { ...buildProps(), placement };
    const { rerender } = render(<ContextMenu {...props} isPreparingContext />);
    const input = screen.getByPlaceholderText('Chiedi a Nous o aggiungi istruzioni');
    expect(input).toBeEnabled();
    await user.type(input, 'Spiega');
    expect(screen.getByRole('button', { name: 'Invia domanda' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Evidenzia selezione' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: /^Nota$/ }));
    const note = screen.getByPlaceholderText(
      'Scrivi la nota che vuoi lasciare su questo passaggio...'
    );
    note.scrollIntoView = vi.fn();
    await user.type(note, 'Appunto');
    expect(screen.getByRole('button', { name: 'Salva nota' })).toBeDisabled();
    rerender(<ContextMenu {...props} isPreparingContext={false} />);
    expect(screen.getByRole('textbox')).toHaveValue('Appunto');
    await user.click(screen.getByRole('button', { name: 'Chiedi a Nous' }));
    expect(screen.getByRole('textbox')).toHaveValue('Spiega');
    await user.click(screen.getByRole('button', { name: 'Nota' }));
    expect(screen.getByRole('textbox')).toHaveValue('Appunto');
    await user.click(screen.getByRole('button', { name: 'Salva nota' }));
    expect(props.onSaveNote).toHaveBeenCalledWith('Appunto', []);
  });
  beforeEach(() => {
    vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(callback => {
      callback(0);
      return 1;
    });
    vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
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

  test('allows whole-lesson creation only after instructions are entered', async () => {
    const user = userEvent.setup();
    const props = {
      ...buildProps(),
      selectedText: '',
      type: 'lesson' as const,
    };

    render(<ContextMenu {...props} />);

    expect(screen.queryByTitle(/Evidenzia il testo selezionato/i)).not.toBeInTheDocument();
    expect(screen.queryByTitle(/Aggiungi una nota a questo passaggio/i)).not.toBeInTheDocument();
    const moreActionsButton = screen.getByRole('button', { name: 'Apri menu' });
    await user.click(moreActionsButton);
    expect(screen.getByRole('menuitem', { name: 'Crea sottolezione' })).toBeDisabled();

    await user.type(screen.getByPlaceholderText(/Chiedi su tutta la lezione/i), 'Fammi una mappa');
    await user.click(moreActionsButton);
    const createLessonItem = screen.getByRole('menuitem', { name: 'Crea sottolezione' });
    expect(createLessonItem).toBeEnabled();
    await user.click(createLessonItem);
    await user.click(screen.getByRole('button', { name: 'Procedi' }));

    expect(props.onCreateLesson).toHaveBeenCalledWith('Fammi una mappa');
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
    await user.click(screen.getByRole('menuitem', { name: 'Crea sottolezione' }));

    const confirmationPanel = screen
      .getByText(/Vuoi creare una nuova sottolezione da questa selezione/i)
      .closest('div[aria-hidden]');

    expect(confirmationPanel).toHaveAttribute('aria-hidden', 'false');
    expect(screen.getAllByText(/Testo selezionato molto importante/i).length).toBeGreaterThan(0);

    await user.click(screen.getByRole('button', { name: 'Annulla' }));
    expect(confirmationPanel).toHaveAttribute('aria-hidden', 'true');

    await user.click(moreActionsButton);
    await user.click(screen.getByRole('menuitem', { name: 'Crea sottolezione' }));
    await user.click(screen.getByRole('button', { name: 'Procedi' }));

    expect(props.onCreateLesson).toHaveBeenCalledWith('Approfondisci il punto');
  });

  test('disables lesson creation and explains the wait while a lesson is generating', async () => {
    const user = userEvent.setup();
    const props = {
      ...buildProps(),
      isLoading: true,
      lessonCreationBlockReason: 'lesson-generation' as const,
    };

    render(<ContextMenu {...props} />);

    await user.click(screen.getByRole('button', { name: 'Apri menu' }));
    const createLessonItem = screen.getByRole('menuitem', {
      name: 'Attendi che la generazione in corso termini',
    });

    expect(createLessonItem).toBeDisabled();
    await user.click(createLessonItem);
    expect(props.onCreateLesson).not.toHaveBeenCalled();
    expect(
      screen
        .getByText(/Vuoi creare una nuova sottolezione da questa selezione/i)
        .closest('[aria-hidden]')
    ).toHaveAttribute('aria-hidden', 'true');
  });

  test('disables an open lesson confirmation when generation starts', async () => {
    const user = userEvent.setup();
    const props = buildProps();
    const { rerender } = render(<ContextMenu {...props} />);

    await user.click(screen.getByRole('button', { name: 'Apri menu' }));
    await user.click(screen.getByRole('menuitem', { name: 'Crea sottolezione' }));

    rerender(<ContextMenu {...props} isLoading lessonCreationBlockReason="lesson-generation" />);

    const pendingButton = screen.getByRole('button', {
      name: 'Attendi che la generazione in corso termini',
    });
    expect(pendingButton).toBeDisabled();
    await user.click(pendingButton);
    expect(props.onCreateLesson).not.toHaveBeenCalled();
  });

  test('does not restore focus to the actions button when loading disables it', async () => {
    const user = userEvent.setup();
    const props = buildProps();
    const { rerender } = render(<ContextMenu {...props} />);

    const moreActionsButton = screen.getByRole('button', { name: 'Apri menu' });
    await user.click(moreActionsButton);
    await user.click(screen.getByRole('menuitem', { name: 'Crea sottolezione' }));

    rerender(<ContextMenu {...props} isLoading />);
    expect(moreActionsButton).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Annulla' }));

    expect(moreActionsButton).not.toHaveFocus();
    expect(document.body).toHaveFocus();
  });

  test('does not describe exercise work as lesson generation', async () => {
    const user = userEvent.setup();

    render(<ContextMenu {...buildProps()} lessonCreationBlockReason="other-operation" />);

    await user.click(screen.getByRole('button', { name: 'Apri menu' }));
    const createLessonItem = screen.getByRole('menuitem', {
      name: 'Operazione in corso…',
    });

    expect(createLessonItem).toBeDisabled();
    expect(screen.queryByText('Generazione sottolezione in corso…')).not.toBeInTheDocument();
  });

  test('closes on escape and disables actions while loading', () => {
    const props = buildProps();
    props.isLoading = true;

    render(<ContextMenu {...props} />);

    fireEvent.keyDown(globalThis.window, { key: 'Escape' });

    expect(props.onClose).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: /Invia domanda/i })).toBeDisabled();
    expect(screen.getByTitle(/Evidenzia il testo selezionato/i)).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Apri menu' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Dettatura test' })).toBeDisabled();
  });

  test.each([
    'pointerDown',
    'touchStart',
  ] as const)('keeps mobile %s actions pending while context loads', eventType => {
    const props = buildProps();
    props.placement = 'mobile-sheet';
    const contextProps = { ...props, isPreparingContext: true };
    render(<ContextMenu {...contextProps} askInputValue="Explain this passage" />);

    fireEvent[eventType](screen.getByRole('button', { name: /Evidenzia selezione/i }));
    fireEvent[eventType](screen.getByRole('button', { name: /Invia domanda/i }));

    expect(props.onHighlight).not.toHaveBeenCalled();
    expect(props.onAsk).not.toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();
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
    const createLessonItem = screen.getByRole('menuitem', { name: 'Crea sottolezione' });
    expect(submenu.parentElement).toBe(portalContainer);
    expect(createLessonItem).toHaveFocus();

    fireEvent.keyDown(globalThis.window, { key: 'Escape' });
    expect(screen.queryByRole('menu', { name: 'Apri menu' })).not.toBeInTheDocument();
    expect(props.onClose).not.toHaveBeenCalled();
    expect(moreActionsButton).toHaveFocus();

    await user.click(moreActionsButton);
    fireEvent.pointerDown(screen.getByPlaceholderText(/Chiedi a Nous/i));
    expect(screen.queryByRole('menu', { name: 'Apri menu' })).not.toBeInTheDocument();
    expect(props.onClose).not.toHaveBeenCalled();
  });

  test('repositions rare actions when content height and viewport geometry change', async () => {
    const user = userEvent.setup();
    const menuGap = 8;
    const viewportPadding = 12;
    const initialMenuHeight = 40;
    const wrappedMenuHeight = 72;
    const triggerHeight = 32;
    const triggerRight = 300;
    const triggerWidth = 32;
    let menuHeight = initialMenuHeight;
    let triggerTop = initialMenuHeight + menuGap + viewportPadding;
    let resizeObserverCallback: ResizeObserverCallback | null = null;
    let resizeObserver: ResizeObserver | null = null;
    const observeMenu = vi.fn();
    class ResizeObserverMock {
      readonly disconnect = vi.fn();
      readonly observe = observeMenu;
      readonly unobserve = vi.fn();

      constructor(callback: ResizeObserverCallback) {
        resizeObserverCallback = callback;
        resizeObserver = this as unknown as ResizeObserver;
      }
    }
    vi.stubGlobal('ResizeObserver', ResizeObserverMock);
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (
      this: HTMLElement
    ) {
      return this.getAttribute('role') === 'menu' ? menuHeight : 0;
    });

    render(
      <ContextMenu {...buildProps()} isLoading lessonCreationBlockReason="lesson-generation" />
    );

    const moreActionsButton = screen.getByRole('button', { name: 'Apri menu' });
    vi.spyOn(moreActionsButton, 'getBoundingClientRect').mockImplementation(() => ({
      bottom: triggerTop + triggerHeight,
      height: triggerHeight,
      left: triggerRight - triggerWidth,
      right: triggerRight,
      top: triggerTop,
      width: triggerWidth,
      x: triggerRight - triggerWidth,
      y: triggerTop,
      toJSON: () => ({}),
    }));

    await user.click(moreActionsButton);

    const submenu = screen.getByRole('menu', { name: 'Apri menu' });
    expect(submenu.style.top).toBe('');
    expect(submenu.style.bottom).toBe(`${globalThis.innerHeight - triggerTop + menuGap}px`);
    expect(observeMenu).toHaveBeenCalledWith(submenu);

    triggerTop = initialMenuHeight + menuGap + viewportPadding - 1;
    fireEvent(globalThis.window, new Event('resize'));

    expect(submenu.style.top).toBe(`${triggerTop + triggerHeight + menuGap}px`);
    expect(submenu.style.bottom).toBe('');

    menuHeight = wrappedMenuHeight;
    act(() => {
      resizeObserverCallback?.([], resizeObserver as ResizeObserver);
    });

    expect(submenu.style.top).toBe(`${triggerTop + triggerHeight + menuGap}px`);
    expect(submenu.style.bottom).toBe('');

    triggerTop = 200;
    fireEvent(globalThis.window, new Event('resize'));

    expect(submenu.style.top).toBe('');
    expect(submenu.style.bottom).toBe(`${globalThis.innerHeight - triggerTop + menuGap}px`);
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
    expect(screen.getByRole('menuitem', { name: 'Crea sottolezione' })).toBeInTheDocument();
  });

  test.each([
    'desktop-floating',
    'mobile-sheet',
  ] as const)('keeps a saved annotation visible while its separate lesson confirmation unfolds on %s', async placement => {
    const user = userEvent.setup();
    const props = {
      ...buildProps(),
      annotationNote: 'Nota salvata da mantenere',
      placement,
      type: 'annotation' as const,
    };

    render(<ContextMenu {...props} />);

    const notePanel = screen.getByText('Nota associata al passaggio').closest('[aria-hidden]');
    const confirmationPanel = screen
      .getByText(/Vuoi creare una nuova sottolezione da questa selezione/i)
      .closest('[aria-hidden]');
    expect(notePanel).toHaveAttribute('aria-hidden', 'false');
    expect(notePanel).not.toHaveAttribute('inert');
    expect(confirmationPanel).toHaveAttribute('aria-hidden', 'true');
    expect(confirmationPanel).toHaveAttribute('inert');

    const moreActionsButton = screen.getByRole('button', { name: 'Apri menu' });
    await user.click(moreActionsButton);
    await user.click(screen.getByRole('menuitem', { name: 'Crea sottolezione' }));

    expect(confirmationPanel).toHaveAttribute('aria-hidden', 'false');
    expect(confirmationPanel).not.toHaveAttribute('inert');
    expect(notePanel).toHaveAttribute('aria-hidden', 'false');
    expect(notePanel).not.toHaveAttribute('inert');

    await user.click(screen.getByRole('button', { name: 'Annulla' }));

    await waitFor(() => expect(moreActionsButton).toHaveFocus());
    expect(notePanel).toHaveAttribute('aria-hidden', 'false');
    expect(notePanel).not.toHaveAttribute('inert');
    expect(confirmationPanel).toHaveAttribute('aria-hidden', 'true');
    expect(confirmationPanel).toHaveAttribute('inert');
    expect(screen.getByText('Nota salvata da mantenere')).toBeInTheDocument();
  });

  test('opens the rare-actions portal and lesson confirmation from the mobile sheet', async () => {
    const user = userEvent.setup();
    const props = buildProps();
    props.placement = 'mobile-sheet';

    render(<ContextMenu {...props} />);

    await user.click(screen.getByRole('button', { name: 'Apri menu' }));
    await user.click(screen.getByRole('menuitem', { name: 'Crea sottolezione' }));

    expect(
      screen
        .getByText(/Vuoi creare una nuova sottolezione da questa selezione/i)
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

  test('opens above when the menu anchor is near the viewport bottom', () => {
    const { container } = render(
      <ContextMenu
        {...buildProps()}
        anchorY={700}
        selectionRect={{ top: 20, left: 200, width: 80, height: 680 }}
      />
    );

    const surface = container.firstElementChild as HTMLElement;
    expect(surface.style.bottom).not.toBe('');
    expect(surface.style.top).toBe('');
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
    expect(top + noteMaxHeight).toBeLessThanOrEqual(globalThis.innerHeight);
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

  test('offers only user-generated artifacts and excludes lesson visuals and source images', async () => {
    const user = userEvent.setup();
    const lessonGeneratedArtifact: LearningArtifactRenderPayload = {
      ...annotationArtifact,
      summary: {
        ...annotationArtifact.summary,
        id: 'project-1:section-1:generated-visual:visual-001',
        title: 'Diagramma della lezione',
      },
      visual: { ...annotationArtifact.visual, id: 'visual-001', title: 'Diagramma della lezione' },
    };
    const durableUserArtifact: LearningArtifactRenderPayload = {
      ...annotationArtifact,
      summary: {
        ...annotationArtifact.summary,
        id: 'project-1:section-1:generated-visual:lesson-visual:run-1:artifact-draft',
        title: 'Schema richiesto dall’utente',
      },
      visual: {
        createdAt: '2026-05-05T10:00:00.000Z',
        id: 'lesson-visual:run-1:artifact-draft',
        render: { code: '<div>Schema</div>', embeddedAssets: [], kind: 'html' },
        slotId: 'artifact-draft',
        title: 'Schema richiesto dall’utente',
      },
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
        artifactPayloads={[
          sourceImageArtifact,
          lessonGeneratedArtifact,
          annotationArtifact,
          durableUserArtifact,
        ]}
      />
    );

    await user.click(screen.getByTitle(/Aggiungi una nota a questo passaggio/i));
    await user.click(screen.getByRole('button', { name: /Allega dagli artefatti/i }));

    expect(screen.getByRole('menuitem', { name: /Allega Mappa salvata/i })).toBeInTheDocument();
    expect(
      screen.getByRole('menuitem', { name: /Allega Schema richiesto dall’utente/i })
    ).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /Diagramma della lezione/i })).toBeNull();
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
    expect(screen.getByRole('button', { name: 'Salva nota' })).toBeInTheDocument();
    expect(screen.queryByText('Rimuovi')).not.toBeInTheDocument();
  });

  test('opens annotation clicks as a rendered note before editing or asking', async () => {
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
    expect(screen.getByRole('button', { name: 'Nota' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByTitle('Rimuovi evidenziazione')).toBeInTheDocument();
    expect(container.querySelector('strong')?.textContent).toBe('chiave');
    expect(container.querySelector('.katex')).not.toBeNull();
    expect(screen.getByRole('table')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Modifica' }));

    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    const textarea = screen.getByPlaceholderText(/Scrivi, aggiorna o svuota la nota/i);
    expect(textarea).toHaveValue(props.annotationNote);
    await user.clear(textarea);
    await user.click(screen.getByRole('button', { name: 'Salva nota' }));

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
