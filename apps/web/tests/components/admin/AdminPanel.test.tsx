// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import AdminPanel from '../../../components/admin/AdminPanel.tsx';
import {
  type AdminModelConfig,
  getAdminModelConfig,
  listAdminUsers,
  patchAdminModelConfig,
  updateAdminUser,
} from '../../../services/admin/adminApi.ts';

vi.mock('../../../services/admin/adminApi.ts', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../services/admin/adminApi.ts')>();
  return {
    ...actual,
    createAdminUser: vi.fn(),
    getAdminModelConfig: vi.fn(),
    listAdminUsers: vi.fn(),
    patchAdminModelConfig: vi.fn(),
    sendAdminMagicLink: vi.fn(),
    updateAdminUser: vi.fn(),
  };
});

const defaultModelConfig = {
  aiProvider: 'openrouter',
  assessmentModel: 'google/gemini-3.1-flash-lite',
  assessmentReasoningEffort: 'medium' as const,
  codexAssessmentModel: 'gpt-5.6-luna',
  codexContextModel: 'gpt-5.6-luna',
  codexLessonModel: 'gpt-5.6-terra',
  codexProgressModel: 'gpt-5.6-luna',
  codexResearchModel: 'gpt-5.6-terra',
  contextModel: 'google/gemini-3.1-flash-lite',
  contextReasoningEffort: 'medium' as const,
  imageModel: 'google/gemini-3.1-flash-lite-image',
  lessonModel: 'openai/gpt-5.4-mini',
  lessonReasoningEffort: 'medium' as const,
  openAiAssessmentModel: 'gpt-5.6-luna',
  openAiContextModel: 'gpt-5.6-luna',
  openAiImageModel: 'gpt-image-2',
  openAiLessonModel: 'gpt-5.6-terra',
  openAiProgressModel: 'gpt-5.6-luna',
  openAiResearchModel: 'gpt-5.6-terra',
  progressModel: 'google/gemini-3.1-flash-lite',
  progressReasoningEffort: 'low' as const,
  researchModel: 'perplexity/sonar-pro-search',
  ttsModel: 'x-ai/grok-voice-tts-1.0',
  ttsVoice: 'Ara',
  updatedAt: '2026-07-07T00:00:00.000Z',
} satisfies AdminModelConfig;

describe('AdminPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listAdminUsers).mockResolvedValue([
      {
        id: 'user-1',
        email: 'student@example.com',
        app_metadata: { role: 'user' },
      },
    ]);
    vi.mocked(getAdminModelConfig).mockResolvedValue(defaultModelConfig);
    vi.mocked(patchAdminModelConfig).mockImplementation(async patch => ({
      ...defaultModelConfig,
      ...patch,
      updatedAt: '2026-07-11T00:00:00.000Z',
    }));
    vi.mocked(updateAdminUser).mockResolvedValue({
      id: 'user-1',
      email: 'student@example.com',
      app_metadata: { role: 'user' },
    });
  });

  test('prefills model fields with backend defaults', async () => {
    render(<AdminPanel />);

    expect(await screen.findByDisplayValue('openai/gpt-5.4-mini')).toBeInTheDocument();
    expect(screen.getAllByDisplayValue('google/gemini-3.1-flash-lite')).toHaveLength(3);
    expect(screen.getByDisplayValue('x-ai/grok-voice-tts-1.0')).toBeInTheDocument();
    expect(screen.getByDisplayValue('google/gemini-3.1-flash-lite-image')).toBeInTheDocument();
    expect(screen.getByDisplayValue('perplexity/sonar-pro-search')).toBeInTheDocument();
    expect(screen.getByDisplayValue('gpt-image-2')).toBeInTheDocument();
    expect(screen.getAllByDisplayValue('gpt-5.6-terra')).toHaveLength(4);
    expect(screen.getByDisplayValue('Ara')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Ragionamento Lezioni' })).toHaveValue('medium');
    expect(screen.getByRole('combobox', { name: 'Ragionamento Contesto' })).toHaveValue('medium');
    expect(screen.getByRole('combobox', { name: 'Ragionamento Assessment' })).toHaveValue('medium');
    expect(screen.getByRole('combobox', { name: 'Ragionamento Avanzamento' })).toHaveValue('low');
    expect(screen.queryByRole('combobox', { name: 'Ragionamento TTS' })).toBeNull();
  });

  test('saves the selected provider together with the provider-specific model mappings', async () => {
    const user = userEvent.setup();
    render(<AdminPanel />);

    const providerSelect = await screen.findByRole('combobox', { name: 'Provider AI attivo' });
    await user.selectOptions(providerSelect, 'codex');
    await user.click(screen.getByRole('button', { name: 'Salva modelli' }));

    await waitFor(() => expect(patchAdminModelConfig).toHaveBeenCalledTimes(1));
    expect(patchAdminModelConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        aiProvider: 'codex',
        codexAssessmentModel: 'gpt-5.6-luna',
        codexLessonModel: 'gpt-5.6-terra',
        openAiLessonModel: 'gpt-5.6-terra',
        lessonModel: 'openai/gpt-5.4-mini',
      })
    );
    expect(await screen.findByRole('status')).toHaveTextContent('Modelli aggiornati.');
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
