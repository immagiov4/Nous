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
  ] as const)('replaces an open saved annotation note with lesson confirmation on %s', async placement => {
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
    expect(notePanel).toHaveAttribute('aria-hidden', 'true');
    expect(notePanel).toHaveAttribute('inert');

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
