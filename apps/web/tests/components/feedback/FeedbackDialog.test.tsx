// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const submitFeedbackMock = vi.hoisted(() => vi.fn());
const captureFeedbackScreenshotMock = vi.hoisted(() => vi.fn());
const getFeedbackDiagnosticsSnapshotMock = vi.hoisted(() => vi.fn());

vi.mock('../../../services/feedback/feedbackApi.ts', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../services/feedback/feedbackApi.ts')>()),
  submitFeedback: submitFeedbackMock,
}));
vi.mock('../../../services/feedback/captureScreenshot.ts', () => ({
  captureFeedbackScreenshot: captureFeedbackScreenshotMock,
}));
vi.mock('../../../services/feedback/browserDiagnostics.ts', () => ({
  getFeedbackDiagnosticsSnapshot: getFeedbackDiagnosticsSnapshotMock,
}));
vi.mock('../../../components/shared/SpeechInputButton.tsx', () => ({
  appendSpeechTranscription: (current: string, transcription: string) =>
    current ? `${current} ${transcription}` : transcription,
  default: ({ onTranscription }: { onTranscription: (text: string) => void }) => (
    <button type="button" onClick={() => onTranscription('Testo dettato dalla voce.')}>
      Voce
    </button>
  ),
}));

const { default: FeedbackDialog } = await import('../../../components/feedback/FeedbackDialog.tsx');

afterEach(cleanup);

describe('FeedbackDialog', () => {
  beforeEach(() => {
    vi.spyOn(window.navigator, 'languages', 'get').mockReturnValue(['it']);
    submitFeedbackMock.mockReset();
    captureFeedbackScreenshotMock.mockReset();
    getFeedbackDiagnosticsSnapshotMock.mockReset();
    getFeedbackDiagnosticsSnapshotMock.mockReturnValue({
      consoleEntries: [
        { level: 'error', message: '[Nous] errore recente', timestamp: '2026-07-16T10:00:00Z' },
      ],
      pageUrl: 'https://nous.test/library',
    });
  });

  test('reuses voice input and sends diagnostics only after explicit consent', async () => {
    const user = userEvent.setup();
    submitFeedbackMock.mockResolvedValue({ id: '42', status: 'submitted' });
    render(<FeedbackDialog onClose={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Voce' }));
    await user.click(screen.getByRole('checkbox', { name: /Allega diagnostica tecnica/ }));
    await user.click(screen.getByRole('button', { name: 'Invia segnalazione' }));

    await waitFor(() =>
      expect(submitFeedbackMock).toHaveBeenCalledWith({
        category: 'bug',
        description: 'Testo dettato dalla voce.',
        diagnostics: {
          consoleEntries: [
            {
              level: 'error',
              message: '[Nous] errore recente',
              timestamp: '2026-07-16T10:00:00Z',
            },
          ],
          pageUrl: 'https://nous.test/library',
        },
        screenshot: undefined,
      })
    );
    expect(await screen.findByText('Segnalazione inviata')).toBeInTheDocument();
  });

  test('keeps diagnostics and screenshots out of suggestions', async () => {
    const user = userEvent.setup();
    submitFeedbackMock.mockResolvedValue({ id: '44', status: 'pending' });
    render(<FeedbackDialog onClose={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Suggerimento' }));
    expect(screen.queryByRole('checkbox', { name: /Allega diagnostica tecnica/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Aggiungi uno screenshot' })).toBeNull();
    await user.type(
      screen.getByRole('textbox', { name: 'Descrizione' }),
      'Vorrei una scorciatoia per la libreria.'
    );
    await user.click(screen.getByRole('button', { name: 'Invia segnalazione' }));

    await waitFor(() =>
      expect(submitFeedbackMock).toHaveBeenCalledWith({
        category: 'enhancement',
        description: 'Vorrei una scorciatoia per la libreria.',
        diagnostics: undefined,
        screenshot: undefined,
      })
    );
  });

  test('does not block submission when optional screenshot capture fails', async () => {
    const user = userEvent.setup();
    captureFeedbackScreenshotMock.mockRejectedValue(new Error('permission denied'));
    submitFeedbackMock.mockResolvedValue({ id: '43', status: 'pending' });
    render(<FeedbackDialog onClose={vi.fn()} />);

    await user.type(
      screen.getByRole('textbox', { name: 'Descrizione' }),
      'La pagina non risponde al click.'
    );
    await user.click(screen.getByRole('button', { name: 'Aggiungi uno screenshot' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Puoi comunque inviare la segnalazione senza allegato.'
    );
    await user.click(screen.getByRole('button', { name: 'Invia segnalazione' }));

    await waitFor(() =>
      expect(submitFeedbackMock).toHaveBeenCalledWith(
        expect.objectContaining({ screenshot: undefined })
      )
    );
  });

  test('keeps keyboard focus inside the modal dialog', async () => {
    const user = userEvent.setup();
    render(<FeedbackDialog onClose={vi.fn()} />);

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Segnala un problema' })).toHaveFocus()
    );
    await user.tab({ shift: true });
    expect(screen.getByRole('button', { name: 'Annulla' })).toHaveFocus();

    await user.tab();
    expect(
      screen
        .getAllByRole('button', { name: 'Chiudi segnalazione' })
        .find(button => button.closest('[role="dialog"]'))
    ).toHaveFocus();
  });
});
