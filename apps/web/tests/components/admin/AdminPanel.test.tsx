// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import AdminPanel from '../../../components/admin/AdminPanel.tsx';
import {
  getAdminModelConfig,
  listAdminUsers,
  updateAdminUser,
} from '../../../services/admin/adminApi.ts';

vi.mock('../../../services/admin/adminApi.ts', () => ({
  DEFAULT_ADMIN_MODEL_CONFIG: {
    assessmentModel: 'google/gemini-3.1-flash-lite',
    assessmentReasoningEffort: 'medium',
    contextModel: 'google/gemini-3.1-flash-lite',
    contextReasoningEffort: 'medium',
    lessonModel: 'openai/gpt-5.4-mini',
    lessonReasoningEffort: 'medium',
    ttsModel: 'x-ai/grok-voice-tts-1.0',
    ttsVoice: 'Ara',
    updatedAt: '',
  },
  createAdminUser: vi.fn(),
  getAdminModelConfig: vi.fn(),
  listAdminUsers: vi.fn(),
  patchAdminModelConfig: vi.fn(),
  sendAdminMagicLink: vi.fn(),
  updateAdminUser: vi.fn(),
}));

const defaultModelConfig = {
  assessmentModel: 'google/gemini-3.1-flash-lite',
  assessmentReasoningEffort: 'medium' as const,
  contextModel: 'google/gemini-3.1-flash-lite',
  contextReasoningEffort: 'medium' as const,
  lessonModel: 'openai/gpt-5.4-mini',
  lessonReasoningEffort: 'medium' as const,
  ttsModel: 'x-ai/grok-voice-tts-1.0',
  ttsVoice: 'Ara',
  updatedAt: '2026-07-07T00:00:00.000Z',
};

describe('AdminPanel', () => {
  beforeEach(() => {
    vi.mocked(listAdminUsers).mockResolvedValue([
      {
        id: 'user-1',
        email: 'student@example.com',
        app_metadata: { role: 'user' },
      },
    ]);
    vi.mocked(getAdminModelConfig).mockResolvedValue(defaultModelConfig);
    vi.mocked(updateAdminUser).mockResolvedValue({
      id: 'user-1',
      email: 'student@example.com',
      app_metadata: { role: 'user' },
    });
  });

  test('prefills model fields with backend defaults', async () => {
    render(<AdminPanel />);

    expect(await screen.findByDisplayValue('openai/gpt-5.4-mini')).toBeInTheDocument();
    expect(screen.getAllByDisplayValue('google/gemini-3.1-flash-lite')).toHaveLength(2);
    expect(screen.getByDisplayValue('x-ai/grok-voice-tts-1.0')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Ara')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Ragionamento Lezioni' })).toHaveValue('medium');
    expect(screen.getByRole('combobox', { name: 'Ragionamento Contesto' })).toHaveValue('medium');
    expect(screen.getByRole('combobox', { name: 'Ragionamento Assessment' })).toHaveValue('medium');
    expect(screen.queryByRole('combobox', { name: 'Ragionamento TTS' })).toBeNull();
  });

  test('lets admins set a user password manually', async () => {
    const user = userEvent.setup();
    render(<AdminPanel />);

    await screen.findByText('student@example.com');
    await user.click(screen.getByRole('button', { name: /password/i }));
    await user.type(screen.getByLabelText('Nuova password per student@example.com'), 'g1ovann1');
    await user.click(screen.getByRole('button', { name: 'Salva password' }));

    expect(updateAdminUser).toHaveBeenCalledWith('user-1', { password: 'g1ovann1' });
  });
});
