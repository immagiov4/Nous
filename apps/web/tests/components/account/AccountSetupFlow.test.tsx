// @vitest-environment jsdom
import { EMPTY_ACCOUNT_PREFERENCES } from '@shared/accountPreferences';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AccountSetupFlow from '../../../components/account/setup/AccountSetupFlow.tsx';
import type { SetupAdapter } from '../../../components/account/setup/useSetup.ts';
import { setRenderingLocaleOverride } from '../../../i18n/uiMessages.ts';

describe('initial account setup', () => {
  beforeEach(() => {
    setRenderingLocaleOverride('it');
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['it']);
  });
  afterEach(() => {
    cleanup();
    setRenderingLocaleOverride(null);
    vi.restoreAllMocks();
  });
  const createAdapter = (): SetupAdapter => ({
    load: vi.fn(async () => ({ ...EMPTY_ACCOUNT_PREFERENCES })),
    finish: vi.fn(async () => {}),
  });
  const advance = () => fireEvent.click(screen.getByRole('button', { name: 'Continua' }));
  it('previews browser language separately from the saved account language', async () => {
    setRenderingLocaleOverride('en');
    const adapter = createAdapter();
    vi.mocked(adapter.load).mockResolvedValue({
      ...EMPTY_ACCOUNT_PREFERENCES,
      interfaceLocale: 'en',
    });
    render(<AccountSetupFlow adapter={adapter} onExit={vi.fn()} />);
    fireEvent.change(await screen.findByLabelText('Interface language'), { target: { value: '' } });
    expect(screen.getByLabelText('Lingua interfaccia')).toHaveValue('');
    expect(adapter.finish).not.toHaveBeenCalled();
  });

  it('keeps the example out of saved data and accepts an empty optional preference', async () => {
    const adapter = createAdapter();
    render(<AccountSetupFlow adapter={adapter} onExit={vi.fn()} />);
    await screen.findByLabelText('Lingua interfaccia');
    advance();
    expect(screen.getByRole('textbox', { name: 'Preferenze didattiche' })).toHaveValue('');
    expect(screen.getByRole('heading', { level: 1 })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Entra in Nous' }));
    await waitFor(() => expect(screen.queryByRole('heading')).not.toBeInTheDocument());
    expect(adapter.finish).toHaveBeenCalledExactlyOnceWith({
      status: 'completed',
      preferences: EMPTY_ACCOUNT_PREFERENCES,
    });
  });

  it('preserves independent content language, edits and back navigation', async () => {
    const adapter = createAdapter();
    render(<AccountSetupFlow adapter={adapter} onExit={vi.fn()} />);
    fireEvent.change(await screen.findByLabelText('Lingua dei contenuti'), {
      target: { value: '日本語' },
    });
    advance();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Spiega ogni simbolo.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Indietro' }));
    expect(screen.getByLabelText('Lingua dei contenuti')).toHaveValue('日本語');
    advance();
    expect(screen.getByRole('textbox')).toHaveValue('Spiega ogni simbolo.');
    fireEvent.click(screen.getByRole('button', { name: 'Salta per ora' }));
    await waitFor(() =>
      expect(adapter.finish).toHaveBeenCalledExactlyOnceWith({ status: 'skipped' })
    );
  });

  it('retains a failed save for retry and suppresses repeated submissions while pending', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const adapter = createAdapter();
    let release: (() => void) | undefined;
    vi.mocked(adapter.finish)
      .mockRejectedValueOnce(new Error('offline'))
      .mockImplementationOnce(
        () =>
          new Promise(resolve => {
            release = resolve;
          })
      );
    render(<AccountSetupFlow adapter={adapter} onExit={vi.fn()} />);
    await screen.findByLabelText('Lingua interfaccia');
    advance();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Esempi concreti.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Entra in Nous' }));
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'Entra in Nous' }));
    expect(screen.getByRole('button', { name: 'Salvataggio…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Salta per ora' })).toBeDisabled();
    await act(async () => release?.());
    expect(adapter.finish).toHaveBeenCalledTimes(2);
    expect(vi.mocked(adapter.finish).mock.calls[1][0]).toMatchObject({
      preferences: { teachingPreferences: 'Esempi concreti.' },
    });
  });

  it('does not expose an empty form when loading and skipping both fail', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const adapter = createAdapter();
    vi.mocked(adapter.load).mockRejectedValueOnce(new Error('offline'));
    vi.mocked(adapter.finish).mockRejectedValueOnce(new Error('offline'));
    render(<AccountSetupFlow adapter={adapter} onExit={vi.fn()} />);
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'Salta per ora' }));
    await screen.findByRole('alert');
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Riprova' }));
    await screen.findByLabelText('Lingua interfaccia');
  });
});
