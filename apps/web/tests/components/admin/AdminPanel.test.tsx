// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import AdminPanel from '../../../components/admin/AdminPanel.tsx';
import {
  type AdminModelConfig,
  createAdminUser,
  getAdminModelConfig,
  listAdminUsers,
  patchAdminModelConfig,
  sendAdminMagicLink,
  updateAdminUser,
} from '../../../services/admin/adminApi.ts';

const codexApiMocks = vi.hoisted(() => ({
  cancelCodexDeviceLogin: vi.fn(),
  loadCodexProviderStatus: vi.fn(),
  logoutCodexProvider: vi.fn(),
  startCodexDeviceLogin: vi.fn(),
}));

vi.mock('../../../services/ai/codexAccountApi.ts', () => codexApiMocks);

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
  artifactModel: 'deepseek/deepseek-v4-pro',
  artifactInteractiveModel: 'openai/gpt-5.6-terra',
  artifactInteractiveReasoningEffort: 'low' as const,
  artifactReasoningEffort: 'none' as const,
  artifactVisualReviewEnabled: true,
  artifactVisualReviewMaxRounds: 1,
  assessmentModel: 'google/gemini-3.1-flash-lite',
  assessmentReasoningEffort: 'medium' as const,
  codexAssessmentModel: 'gpt-5.6-luna',
  codexArtifactModel: 'gpt-5.6-sol',
  codexArtifactInteractiveModel: 'gpt-5.6-sol',
  codexContextModel: 'gpt-5.6-luna',
  codexLessonModel: 'gpt-5.6-terra',
  codexProgressModel: 'gpt-5.6-luna',
  codexResearchModel: 'gpt-5.6-terra',
  contextModel: 'google/gemini-3.1-flash-lite',
  contextReasoningEffort: 'medium' as const,
  imageModel: 'google/gemini-3.1-flash-lite-image',
  lessonModel: 'openai/gpt-5.6-luna',
  lessonReasoningEffort: 'high' as const,
  openAiAssessmentModel: 'gpt-5.6-luna',
  openAiArtifactModel: 'gpt-5.6-terra',
  openAiArtifactInteractiveModel: 'gpt-5.6-terra',
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
    codexApiMocks.loadCodexProviderStatus.mockResolvedValue({
      account: null,
      enabled: true,
      models: [],
    });
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
    vi.mocked(createAdminUser).mockResolvedValue({
      id: 'user-2',
      email: 'new@example.com',
      app_metadata: { ai_provider: 'openai', role: 'user' },
    });
    vi.mocked(sendAdminMagicLink).mockResolvedValue();
  });

  test('prefills model fields with backend defaults', async () => {
    render(<AdminPanel />);

    expect(await screen.findByDisplayValue('deepseek/deepseek-v4-pro')).toBeInTheDocument();
    expect(screen.getByDisplayValue('openai/gpt-5.6-terra')).toBeInTheDocument();
    expect(screen.getByDisplayValue('openai/gpt-5.6-luna')).toBeInTheDocument();
    expect(screen.getAllByDisplayValue('google/gemini-3.1-flash-lite')).toHaveLength(3);
    expect(screen.getByDisplayValue('x-ai/grok-voice-tts-1.0')).toBeInTheDocument();
    expect(screen.getByDisplayValue('google/gemini-3.1-flash-lite-image')).toBeInTheDocument();
    expect(screen.getByDisplayValue('perplexity/sonar-pro-search')).toBeInTheDocument();
    expect(screen.getByDisplayValue('gpt-image-2')).toBeInTheDocument();
    expect(screen.getAllByDisplayValue('gpt-5.6-sol')).toHaveLength(2);
    expect(screen.getAllByDisplayValue('gpt-5.6-terra')).toHaveLength(6);
    expect(screen.getByDisplayValue('Ara')).toBeInTheDocument();
    const artifactReasoningSelects = screen.getAllByRole('combobox', {
      name: 'Ragionamento Artefatti visuali',
    });
    expect(artifactReasoningSelects).toHaveLength(3);
    artifactReasoningSelects.forEach(select => {
      expect(select).toHaveValue('none');
    });
    const interactiveReasoningSelects = screen.getAllByRole('combobox', {
      name: 'Ragionamento Artefatti interattivi',
    });
    expect(interactiveReasoningSelects).toHaveLength(3);
    interactiveReasoningSelects.forEach(select => {
      expect(select).toHaveValue('low');
    });
    const lessonReasoningSelects = screen.getAllByRole('combobox', {
      name: 'Ragionamento Lezioni',
    });
    expect(lessonReasoningSelects).toHaveLength(3);
    lessonReasoningSelects.forEach(select => {
      expect(select).toHaveValue('high');
    });
    expect(screen.getAllByRole('combobox', { name: 'Ragionamento Contesto' })).toHaveLength(3);
    expect(screen.getAllByRole('combobox', { name: 'Ragionamento Assessment' })).toHaveLength(3);
    expect(screen.getAllByRole('combobox', { name: 'Ragionamento Avanzamento' })[0]).toHaveValue(
      'low'
    );
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
        lessonModel: 'openai/gpt-5.6-luna',
      })
    );
    expect(await screen.findByRole('status')).toHaveTextContent('Modelli aggiornati.');
  });

  test('configures artifact models and reasoning independently from lessons', async () => {
    const user = userEvent.setup();
    render(<AdminPanel />);

    const artifactModelInputs = await screen.findAllByLabelText('Modello Artefatti visuali');
    expect(artifactModelInputs).toHaveLength(3);
    const [openRouterArtifactInput, openAiArtifactInput, codexArtifactInput] = artifactModelInputs;
    if (!openRouterArtifactInput || !openAiArtifactInput || !codexArtifactInput) {
      throw new Error('Artifact model inputs are missing.');
    }
    fireEvent.change(openRouterArtifactInput, { target: { value: 'openrouter/artifact-sol' } });
    fireEvent.change(openAiArtifactInput, { target: { value: 'openai-artifact-sol' } });
    fireEvent.change(codexArtifactInput, { target: { value: 'codex-artifact-sol' } });
    const artifactReasoningSelects = screen.getAllByRole('combobox', {
      name: 'Ragionamento Artefatti visuali',
    });
    const artifactReasoningSelect = artifactReasoningSelects[0];
    if (!artifactReasoningSelect) {
      throw new Error('Artifact reasoning select is missing.');
    }
    await user.selectOptions(artifactReasoningSelect, 'none');
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Round massimi di revisione' }), {
      target: { value: '3' },
    });
    await user.click(screen.getByRole('checkbox', { name: 'Revisione visiva degli artefatti' }));
    for (const select of artifactReasoningSelects) {
      expect(select).toHaveValue('none');
    }
    await user.click(screen.getByRole('button', { name: 'Salva modelli' }));

    await waitFor(() =>
      expect(patchAdminModelConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          artifactModel: 'openrouter/artifact-sol',
          artifactReasoningEffort: 'none',
          artifactVisualReviewEnabled: false,
          artifactVisualReviewMaxRounds: 3,
          codexArtifactModel: 'codex-artifact-sol',
          openAiArtifactModel: 'openai-artifact-sol',
          lessonModel: defaultModelConfig.lessonModel,
        })
      )
    );
  });

  test('creates a user with the selected AI provider', async () => {
    const user = userEvent.setup();
    render(<AdminPanel />);

    fireEvent.change(await screen.findByLabelText('Email nuovo account'), {
      target: { value: 'new@example.com' },
    });
    fireEvent.change(screen.getByLabelText('Password nuovo account'), {
      target: { value: 'g1ovann1' },
    });
    await user.selectOptions(screen.getByLabelText('Provider AI nuovo account'), 'openai');
    await user.click(screen.getByRole('button', { name: 'Crea' }));

    await waitFor(() =>
      expect(createAdminUser).toHaveBeenCalledWith({
        aiProvider: 'openai',
        email: 'new@example.com',
        password: 'g1ovann1',
        role: 'user',
      })
    );
  });

  test('sets and clears a user-specific AI provider', async () => {
    const user = userEvent.setup();
    vi.mocked(listAdminUsers).mockResolvedValue([
      {
        id: 'user-1',
        email: 'student@example.com',
        app_metadata: { ai_provider: 'openai', role: 'user' },
      },
    ]);
    render(<AdminPanel />);

    const providerSelect = await screen.findByRole('combobox', {
      name: 'Provider AI per student@example.com',
    });
    expect(providerSelect).toHaveValue('openai');

    await user.selectOptions(providerSelect, 'codex');
    await waitFor(() =>
      expect(updateAdminUser).toHaveBeenCalledWith('user-1', { aiProvider: 'codex' })
    );

    await user.selectOptions(providerSelect, 'default');
    await waitFor(() =>
      expect(updateAdminUser).toHaveBeenLastCalledWith('user-1', { aiProvider: null })
    );
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

  test('shows the magic-link destination and prevents duplicate sends while pending', async () => {
    const user = userEvent.setup();
    let resolveSend: (() => void) | undefined;
    vi.mocked(sendAdminMagicLink).mockReturnValue(
      new Promise<void>(resolve => {
        resolveSend = resolve;
      })
    );
    render(<AdminPanel />);

    const button = await screen.findByRole('button', {
      name: 'Invia link di accesso a student@example.com',
    });
    await user.click(button);

    expect(sendAdminMagicLink).toHaveBeenCalledWith('user-1');
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent('Invio in corso…');

    resolveSend?.();
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Link di accesso inviato a student@example.com.'
    );
    expect(button).toBeEnabled();
  });

  test('shows a stable error when magic-link delivery fails', async () => {
    const user = userEvent.setup();
    vi.mocked(sendAdminMagicLink).mockRejectedValue(new Error('provider detail'));
    render(<AdminPanel />);

    await user.click(
      await screen.findByRole('button', {
        name: 'Invia link di accesso a student@example.com',
      })
    );

    expect(await screen.findByRole('alert')).toHaveTextContent('Invio magic link non riuscito.');
    expect(screen.queryByText('provider detail')).not.toBeInTheDocument();
  });
});
