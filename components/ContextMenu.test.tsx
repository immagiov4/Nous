// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, afterEach, describe, expect, test, vi } from 'vitest';
import ContextMenu from './ContextMenu.tsx';

const buildProps = () => ({
  anchorX: 240,
  anchorY: 180,
  isLoading: false,
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

    await user.type(screen.getByPlaceholderText(/Chiedi a Lumina/i), '   Come funziona?   ');
    await user.click(screen.getByRole('button', { name: /Invia domanda/i }));

    expect(props.onAsk).toHaveBeenCalledTimes(1);
    expect(props.onAsk).toHaveBeenCalledWith('Come funziona?');
    expect(props.onClose).not.toHaveBeenCalled();
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

    await user.type(screen.getByPlaceholderText(/Chiedi a Lumina/i), 'Domanda mobile');
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

    fireEvent.change(screen.getByPlaceholderText(/Chiedi a Lumina/i), {
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

    await user.type(screen.getByPlaceholderText(/Chiedi a Lumina/i), 'Approfondisci il punto');

    const lessonButton = screen.getByTitle(/Crea una nuova lezione dedicata a questo punto/i);
    await user.click(lessonButton);

    const confirmationPanel = screen
      .getByText(/Vuoi creare una nuova lezione da questa selezione/i)
      .closest('div[aria-hidden]');

    expect(confirmationPanel).toHaveAttribute('aria-hidden', 'false');
    expect(screen.getAllByText(/Testo selezionato molto importante/i).length).toBeGreaterThan(0);

    await user.click(screen.getByRole('button', { name: 'Annulla' }));
    expect(confirmationPanel).toHaveAttribute('aria-hidden', 'true');

    await user.click(lessonButton);
    await user.click(screen.getByRole('button', { name: 'Procedi' }));

    expect(props.onCreateLesson).toHaveBeenCalledWith('Approfondisci il punto');
  });

  test('closes on escape and disables actions while loading', () => {
    const props = buildProps();
    props.isLoading = true;

    render(<ContextMenu {...props} />);

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(props.onClose).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: /Inserisci una domanda/i })).toBeDisabled();
    expect(screen.getByTitle(/Evidenzia il testo selezionato/i)).toBeDisabled();
    expect(screen.getByTitle(/Crea una nuova lezione dedicata a questo punto/i)).toBeDisabled();
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

    expect(props.onSaveNote).toHaveBeenCalledWith('Ricordati di rivedere questo concetto');
  });

  test('renders annotation mode with prefilled note, supports clearing it and deleting the evidenziazione', async () => {
    const user = userEvent.setup();
    const props = {
      ...buildProps(),
      annotationNote: 'Nota gia presente',
      type: 'annotation' as const,
    };

    render(<ContextMenu {...props} />);

    const textarea = screen.getByDisplayValue('Nota gia presente');
    await user.clear(textarea);
    await user.click(screen.getByRole('button', { name: 'Salva' }));

    expect(props.onSaveNote).toHaveBeenCalledWith('');

    await user.click(screen.getByRole('button', { name: /Rimuovi evidenziazione/i }));
    expect(props.onDeleteAnnotation).toHaveBeenCalledTimes(1);
  });
});
