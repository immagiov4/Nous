// @vitest-environment jsdom
import { EMPTY_ACCOUNT_PREFERENCES } from '@shared/accountPreferences';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import PreferencesPanel from '../../../components/account/PreferencesPanel.tsx';
import { getAppLocale, setAccountLocale } from '../../../i18n/uiMessages.ts';

const api = vi.hoisted(() => ({
  loadAccountPreferences: vi.fn(),
  saveAccountPreferences: vi.fn(),
  clearAccountPreferences: vi.fn(),
}));
vi.mock('../../../services/preferences/accountPreferences.ts', () => api);

describe('saved account preferences', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(navigator, 'languages', 'get').mockReturnValue(['en']);
    setAccountLocale(null);
    api.loadAccountPreferences.mockResolvedValue({ ...EMPTY_ACCOUNT_PREFERENCES });
    api.saveAccountPreferences.mockImplementation(async preferences => {
      setAccountLocale(preferences.interfaceLocale);
      return preferences;
    });
    api.clearAccountPreferences.mockImplementation(async () => {
      setAccountLocale(null);
      return { ...EMPTY_ACCOUNT_PREFERENCES };
    });
  });
  afterEach(() => {
    cleanup();
    setAccountLocale(null);
    vi.restoreAllMocks();
  });

  test.each([
    ['AI language', 'contentLanguage', 100],
    ['Teaching preferences (optional)', 'teachingPreferences', 4_000],
  ] as const)('keeps oversized %s intact, blocks saving and accepts correction', async (name, field, limit) => {
    const user = userEvent.setup();
    render(<PreferencesPanel />);
    const input = await screen.findByRole('textbox', { name });
    const oversized = 'x'.repeat(limit + 1);
    await user.click(input);
    await user.paste(oversized);
    expect(input).toHaveValue(oversized);
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription(expect.stringContaining(String(limit)));
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save preferences' })).toBeDisabled();
    const form = input.closest('form');
    if (!form) throw new Error('Preferences form is missing.');
    fireEvent.submit(form);
    expect(api.saveAccountPreferences).not.toHaveBeenCalled();
    await user.clear(input);
    const boundary = oversized.slice(1);
    await user.paste(` ${boundary}\n`);
    expect(screen.queryByRole('alert')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Save preferences' }));
    expect(api.saveAccountPreferences).toHaveBeenCalledWith({
      ...EMPTY_ACCOUNT_PREFERENCES,
      [field]: boundary,
    });
    expect(input).toHaveValue(boundary);
  });

  test('can clear saved preferences while the edited text exceeds a limit', async () => {
    const user = userEvent.setup();
    render(<PreferencesPanel />);
    const input = await screen.findByRole('textbox', { name: 'Teaching preferences (optional)' });
    await user.click(input);
    await user.paste('x'.repeat(4_001));
    await user.click(screen.getByRole('button', { name: 'Clear saved preferences' }));
    expect(api.clearAccountPreferences).toHaveBeenCalledOnce();
    expect(api.saveAccountPreferences).not.toHaveBeenCalled();
    expect(input).toHaveValue('');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('saves independent interface and AI languages and clears the saved defaults', async () => {
    const user = userEvent.setup();
    render(<PreferencesPanel />);
    await user.selectOptions(await screen.findByRole('combobox'), 'it');
    await user.type(screen.getByRole('textbox', { name: 'AI language' }), '日本語');
    await user.type(
      screen.getByRole('textbox', { name: 'Teaching preferences (optional)' }),
      'Use one worked example.'
    );
    await user.click(screen.getByRole('button', { name: 'Save preferences' }));
    expect(api.saveAccountPreferences).toHaveBeenCalledWith({
      interfaceLocale: 'it',
      contentLanguage: '日本語',
      teachingPreferences: 'Use one worked example.',
    });
    expect(getAppLocale()).toBe('it');
    await user.click(screen.getByRole('button', { name: 'Cancella preferenze salvate' }));
    expect(api.clearAccountPreferences).toHaveBeenCalledOnce();
    expect(getAppLocale()).toBe('en');
    expect(screen.getByRole('textbox', { name: 'AI language' })).toHaveValue('');
    expect(screen.getByRole('textbox', { name: 'Teaching preferences (optional)' })).toHaveValue(
      ''
    );
  });

  test('keeps a failed draft editable and supports retrying an unavailable initial load', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    api.loadAccountPreferences.mockRejectedValueOnce(new Error('offline'));
    const user = userEvent.setup();
    render(<PreferencesPanel />);
    await user.click(await screen.findByRole('button', { name: 'Retry' }));
    await screen.findByRole('combobox');
    api.saveAccountPreferences.mockRejectedValueOnce(new Error('offline'));
    const input = screen.getByRole('textbox', { name: 'Teaching preferences (optional)' });
    await user.type(input, 'Keep explanations short.');
    await user.click(screen.getByRole('button', { name: 'Save preferences' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(input).toHaveValue('Keep explanations short.');
    expect(screen.getByRole('button', { name: 'Save preferences' })).toBeEnabled();
  });

  test('ignores an obsolete StrictMode failure after the current load succeeds', async () => {
    let failOldLoad!: (error: Error) => void;
    api.loadAccountPreferences.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          failOldLoad = reject;
        })
    );
    render(
      <StrictMode>
        <PreferencesPanel />
      </StrictMode>
    );
    await screen.findByRole('combobox');
    await act(async () => failOldLoad(new Error('obsolete failure')));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('textbox', { name: 'AI language' })).toHaveValue('');
  });
});
