// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';

import HomeChatPanel from '../../../components/library/HomeChatPanel.tsx';

const buildProps = () => ({
  assessmentComplete: false,
  isDarkMode: false,
  isLoading: false,
  loadingStatus: 'Caricamento...',
  messages: [],
  onClearPendingFile: vi.fn(),
  onConfirmGenerate: vi.fn(),
  onSendMessage: vi.fn(async () => {}),
  onUploadSourceClick: vi.fn(),
  pendingFileName: null,
});

describe('HomeChatPanel', () => {
  test('centers the tool menu above the trigger on mobile widths', async () => {
    const user = userEvent.setup();
    const props = buildProps();

    render(<HomeChatPanel {...props} />);

    await user.click(screen.getByTitle(/Apri strumenti conversazione/i));

    const menu = screen.getByRole('menu');
    expect(menu).toHaveClass('left-1/2');
    expect(menu).toHaveClass('-translate-x-1/2');
    expect(menu).toHaveClass('w-[min(18rem,calc(100%-1rem))]');
    expect(menu).toHaveClass('bg-white');
    expect(menu).not.toHaveClass('bg-white/95');
  });

  test('passes the Nuovo corso preference when the tool toggle is enabled', async () => {
    const user = userEvent.setup();
    const props = buildProps();

    render(<HomeChatPanel {...props} />);

    await user.click(screen.getByTitle(/Apri strumenti conversazione/i));
    await user.click(screen.getByRole('menuitemcheckbox', { name: /Nuovo corso/i }));
    await user.type(
      screen.getByPlaceholderText(/Descrivi un argomento o allega un file/i),
      'Vorrei organizzare meglio il corso'
    );
    await user.click(screen.getByRole('button', { name: /Inizia/i }));

    expect(props.onSendMessage).toHaveBeenCalledWith('Vorrei organizzare meglio il corso', {
      toolPreferences: { newCourse: true },
    });
    expect(screen.getByText(/Nuovo corso attivo/i)).toBeInTheDocument();
  });
});
