// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';

import OpenRouterModelPanel from '../../../components/shared/OpenRouterModelPanel.tsx';

const renderPanel = (onNotesChange = vi.fn(), value = 'Spiega lentamente') =>
  render(
    <OpenRouterModelPanel
      courseNotes={{
        value,
        onChange: onNotesChange,
      }}
    />
  );

describe('OpenRouterModelPanel', () => {
  test('keeps global model selection out of the reader panel', () => {
    renderPanel();

    expect(screen.queryByText('Modelli IA')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Lezioni')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Domande rapide')).not.toBeInTheDocument();
  });

  test('saves custom instructions on blur only when changed', async () => {
    const user = userEvent.setup();
    const onNotesChange = vi.fn();
    renderPanel(onNotesChange);

    const notesInput = screen.getByDisplayValue('Spiega lentamente');
    await user.type(notesInput, ' in matematica');

    expect(onNotesChange).not.toHaveBeenCalled();

    await user.tab();

    expect(onNotesChange).toHaveBeenCalledWith('Spiega lentamente in matematica');
  });

  test('does not save custom instructions on blur when unchanged', async () => {
    const user = userEvent.setup();
    const onNotesChange = vi.fn();
    renderPanel(onNotesChange);

    screen.getByDisplayValue('Spiega lentamente').focus();
    await user.tab();

    expect(onNotesChange).not.toHaveBeenCalled();
  });

  test('saves custom instructions before closing from outside click', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onNotesChange = vi.fn();
    render(
      <div>
        <button type="button">Fuori</button>
        <OpenRouterModelPanel
          courseNotes={{
            value: 'Spiega lentamente',
            onChange: onNotesChange,
          }}
          onClose={onClose}
        />
      </div>
    );

    await user.type(screen.getByDisplayValue('Spiega lentamente'), ' in matematica');
    await user.click(screen.getByText('Fuori'));

    expect(onNotesChange).toHaveBeenCalledWith('Spiega lentamente in matematica');
    expect(onClose).toHaveBeenCalled();
  });
});
