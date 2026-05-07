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
      defaultModels={{
        assessmentModel: 'google/gemini-3.1-flash-lite',
        contextModel: 'google/gemini-3.1-flash-lite',
        lessonModel: 'openai/gpt-5.4-mini',
        ttsModel: 'openai/gpt-4o-mini-tts',
        ttsVoice: 'alloy',
      }}
      onModelChange={vi.fn()}
      preferredModels={{
        preferredAssessmentModel: '',
        preferredContextModel: '',
        preferredLessonModel: '',
        preferredTtsModel: '',
        preferredTtsVoice: '',
      }}
    />
  );

describe('OpenRouterModelPanel', () => {
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
          defaultModels={{
            assessmentModel: 'google/gemini-3.1-flash-lite',
            contextModel: 'google/gemini-3.1-flash-lite',
            lessonModel: 'openai/gpt-5.4-mini',
            ttsModel: 'openai/gpt-4o-mini-tts',
            ttsVoice: 'alloy',
          }}
          onClose={onClose}
          onModelChange={vi.fn()}
          preferredModels={{
            preferredAssessmentModel: '',
            preferredContextModel: '',
            preferredLessonModel: '',
            preferredTtsModel: '',
            preferredTtsVoice: '',
          }}
        />
      </div>
    );

    await user.type(screen.getByDisplayValue('Spiega lentamente'), ' in matematica');
    await user.click(screen.getByText('Fuori'));

    expect(onNotesChange).toHaveBeenCalledWith('Spiega lentamente in matematica');
    expect(onClose).toHaveBeenCalled();
  });
});
