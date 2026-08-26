// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import AdminPanel from '../../../components/admin/AdminPanel.tsx';
import {
  type AdminModelConfig,
  createAdminUser,
  getAdminModelConfig,
  listAdminFeedback,
  listAdminUsers,
  loadAdminFeedbackScreenshot,
  loadCourseCoverRegenerationStatus,
  patchAdminModelConfig,
  retryAdminFeedback,
  sendAdminAccessEmail,
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
    listAdminFeedback: vi.fn(),
    listAdminUsers: vi.fn(),
    loadCourseCoverRegenerationStatus: vi.fn(),
    loadAdminFeedbackScreenshot: vi.fn(),
    patchAdminModelConfig: vi.fn(),
    retryAdminFeedback: vi.fn(),
    sendAdminAccessEmail: vi.fn(),
    sendAdminMagicLink: vi.fn(),
    startCourseCoverRegeneration: vi.fn(),
    updateAdminUser: vi.fn(),
  };
});

const defaultModelConfig = {
  aiProvider: 'openrouter',
  aiProviderOverrides: {},
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
  codexCourseModel: 'gpt-5.6-luna',
  codexFastModelSlots: ['artifact', 'artifactInteractive', 'course', 'lesson'],
  codexLessonModel: 'gpt-5.6-terra',
  codexProgressModel: 'gpt-5.6-luna',
  codexResearchModel: 'gpt-5.6-terra',
  contextModel: 'google/gemini-3.1-flash-lite',
  contextReasoningEffort: 'medium' as const,
  courseModel: 'openai/gpt-5.6-luna',
  courseReasoningEffort: 'medium' as const,
  imageModel: 'google/gemini-3.1-flash-lite-image',
  lessonModel: 'openai/gpt-5.6-luna',
  lessonReasoningEffort: 'high' as const,
  openAiAssessmentModel: 'gpt-5.6-luna',
  openAiArtifactModel: 'gpt-5.6-terra',
  openAiArtifactInteractiveModel: 'gpt-5.6-terra',
  openAiContextModel: 'gpt-5.6-luna',
  openAiCourseModel: 'gpt-5.6-terra',
  openAiImageModel: 'gpt-image-2',
  openAiLessonModel: 'gpt-5.6-terra',
  openAiProgressModel: 'gpt-5.6-luna',
  openAiResearchModel: 'gpt-5.6-terra',
  progressModel: 'google/gemini-3.1-flash-lite',
  progressReasoningEffort: 'low' as const,
  researchModel: 'perplexity/sonar-pro-search',
  researchReasoningEffort: 'none' as const,
  ttsModel: 'x-ai/grok-voice-tts-1.0',
  ttsVoice: 'Ara',
  updatedAt: '2026-07-07T00:00:00.000Z',
} satisfies AdminModelConfig;

const openConfiguration = async (user: ReturnType<typeof userEvent.setup>) => {
  await screen.findByText('student@example.com');
  await user.click(screen.getByRole('button', { name: 'Configurazione' }));
};

const openProviderSections = async (user: ReturnType<typeof userEvent.setup>) => {
  for (const provider of ['OpenRouter', 'OpenAI API', 'Codex app-server']) {
    await user.click(screen.getByText(provider, { selector: 'summary span.flex-1' }));
  }
};

const createDeferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

describe('AdminPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    codexApiMocks.loadCodexProviderStatus.mockResolvedValue({
      account: null,
      enabled: true,
      models: [],
    });
    vi.mocked(listAdminUsers).mockResolvedValue({
      hasMore: false,
      page: 1,
      pageSize: 8,
      users: [
        {
          id: 'user-1',
          email: 'student@example.com',
          app_metadata: { role: 'user' },
        },
      ],
    });
    vi.mocked(getAdminModelConfig).mockResolvedValue(defaultModelConfig);
    vi.mocked(listAdminFeedback).mockResolvedValue({
      page: 1,
      pageSize: 10,
      reports: [],
      total: 0,
    });
    vi.mocked(loadAdminFeedbackScreenshot).mockResolvedValue(new Blob(['image']));
    vi.mocked(loadCourseCoverRegenerationStatus).mockResolvedValue(null);
    vi.mocked(retryAdminFeedback).mockResolvedValue();
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
    vi.mocked(sendAdminMagicLink).mockResolvedValue('access');
    vi.mocked(sendAdminAccessEmail).mockResolvedValue('access');
  });

  test('prefills model fields with backend defaults', async () => {
    const user = userEvent.setup();
    render(<AdminPanel />);
    await openConfiguration(user);
    await openProviderSections(user);

    expect(await screen.findByDisplayValue('deepseek/deepseek-v4-pro')).toBeInTheDocument();
    expect(screen.getByDisplayValue('openai/gpt-5.6-terra')).toBeInTheDocument();
    expect(screen.getAllByDisplayValue('openai/gpt-5.6-luna')).toHaveLength(2);
    expect(screen.getAllByDisplayValue('google/gemini-3.1-flash-lite')).toHaveLength(3);
    expect(screen.getByDisplayValue('x-ai/grok-voice-tts-1.0')).toBeInTheDocument();
    expect(screen.getByDisplayValue('google/gemini-3.1-flash-lite-image')).toBeInTheDocument();
    expect(screen.getByDisplayValue('perplexity/sonar-pro-search')).toBeInTheDocument();
    expect(screen.getByDisplayValue('gpt-image-2')).toBeInTheDocument();
    expect(screen.getAllByDisplayValue('gpt-5.6-sol')).toHaveLength(2);
    expect(screen.getAllByDisplayValue('gpt-5.6-terra')).toHaveLength(7);
    expect(screen.getByDisplayValue('Ara')).toBeInTheDocument();
    const artifactReasoningSelects = screen.getAllByRole('combobox', {
      name: /Ragionamento Artefatti visuali per/,
    });
    expect(artifactReasoningSelects).toHaveLength(3);
    artifactReasoningSelects.forEach(select => {
      expect(select).toHaveValue('none');
    });
    const interactiveReasoningSelects = screen.getAllByRole('combobox', {
      name: /Ragionamento Artefatti interattivi per/,
    });
    expect(interactiveReasoningSelects).toHaveLength(3);
    interactiveReasoningSelects.forEach(select => {
      expect(select).toHaveValue('low');
    });
    const lessonReasoningSelects = screen.getAllByRole('combobox', {
      name: /Ragionamento Lezioni per/,
    });
    expect(lessonReasoningSelects).toHaveLength(3);
    lessonReasoningSelects.forEach(select => {
      expect(select).toHaveValue('high');
    });
    expect(screen.getAllByRole('combobox', { name: /Ragionamento Contesto per/ })).toHaveLength(3);
    expect(screen.getAllByRole('combobox', { name: /Ragionamento Assessment per/ })).toHaveLength(
      3
    );
    expect(
      screen.getAllByRole('combobox', { name: /Ragionamento Avanzamento per/ })[0]
    ).toHaveValue('low');
    const researchReasoningSelects = screen.getAllByRole('combobox', {
      name: /Ragionamento Ricerca per/,
    });
    expect(researchReasoningSelects).toHaveLength(3);
    researchReasoningSelects.forEach(select => {
      expect(select).toBeEnabled();
      expect(select).toHaveValue('none');
    });
    expect(screen.queryByRole('combobox', { name: 'Ragionamento TTS' })).toBeNull();
  });

  test('saves the selected provider together with the provider-specific model mappings', async () => {
    const user = userEvent.setup();
    render(<AdminPanel />);
    await openConfiguration(user);

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
    expect(await screen.findByText('Modelli aggiornati.')).toBeInTheDocument();
  });

  test('saves a provider override for a single model function', async () => {
    const user = userEvent.setup();
    render(<AdminPanel />);
    await openConfiguration(user);

    await user.selectOptions(
      await screen.findByRole('combobox', { name: 'Provider per Lezioni' }),
      'codex'
    );
    await user.click(screen.getByRole('button', { name: 'Salva modelli' }));

    await waitFor(() =>
      expect(patchAdminModelConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          aiProvider: 'openrouter',
          aiProviderOverrides: { lesson: 'codex' },
        })
      )
    );
  });

  test('does not allow saving model defaults before persisted configuration loads', async () => {
    const user = userEvent.setup();
    const configRequest = createDeferred<AdminModelConfig>();
    vi.mocked(getAdminModelConfig).mockReturnValue(configRequest.promise);
    render(<AdminPanel />);

    await user.click(screen.getByRole('button', { name: 'Configurazione' }));
    expect(screen.getByRole('button', { name: 'Salva modelli' })).toBeDisabled();
    expect(patchAdminModelConfig).not.toHaveBeenCalled();

    await act(async () => configRequest.resolve(defaultModelConfig));
    expect(screen.getByRole('button', { name: 'Salva modelli' })).toBeEnabled();
  });

  test('configures artifact models and reasoning independently from lessons', async () => {
    const user = userEvent.setup();
    render(<AdminPanel />);
    await openConfiguration(user);
    await openProviderSections(user);

    const openRouterArtifactInput = await screen.findByLabelText(
      'Modello Artefatti visuali per OpenRouter'
    );
    const openAiArtifactInput = screen.getByLabelText('Modello Artefatti visuali per OpenAI API');
    const codexArtifactInput = screen.getByLabelText(
      'Modello Artefatti visuali per Codex app-server'
    );
    fireEvent.change(openRouterArtifactInput, { target: { value: 'openrouter/artifact-sol' } });
    fireEvent.change(openAiArtifactInput, { target: { value: 'openai-artifact-sol' } });
    fireEvent.change(codexArtifactInput, { target: { value: 'codex-artifact-sol' } });
    const artifactReasoningSelects = screen.getAllByRole('combobox', {
      name: /Ragionamento Artefatti visuali per/,
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

  test('sends an invitation for a new address and explains the required password step', async () => {
    const user = userEvent.setup();
    vi.mocked(sendAdminAccessEmail).mockResolvedValue('invitation');
    render(<AdminPanel />);

    await user.type(await screen.findByLabelText('Email per invito o accesso'), 'new@example.com');
    await user.click(screen.getByRole('button', { name: 'Invia email' }));

    await waitFor(() => expect(sendAdminAccessEmail).toHaveBeenCalledWith('new@example.com'));
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Invito inviato a new@example.com. Dovrà scegliere una password prima di entrare.'
    );
  });

  test('sets and clears a user-specific AI provider', async () => {
    const user = userEvent.setup();
    vi.mocked(listAdminUsers).mockResolvedValue({
      hasMore: false,
      page: 1,
      pageSize: 8,
      users: [
        {
          id: 'user-1',
          email: 'student@example.com',
          app_metadata: { ai_provider: 'openai', role: 'user' },
        },
      ],
    });
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

  test('sets a user-specific provider override by function', async () => {
    const user = userEvent.setup();
    render(<AdminPanel />);

    await screen.findByText('student@example.com');
    await user.click(screen.getByText('Backend per funzione'));
    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Provider per Contesto' }),
      'codex'
    );

    await waitFor(() =>
      expect(updateAdminUser).toHaveBeenCalledWith('user-1', {
        aiProviderOverrides: { context: 'codex' },
      })
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

  test('keeps the password editor open and does not report success when the update fails', async () => {
    const user = userEvent.setup();
    vi.mocked(updateAdminUser).mockRejectedValue(new Error('Aggiornamento rifiutato.'));
    render(<AdminPanel />);

    await user.click(
      await screen.findByRole('button', { name: 'Imposta password per student@example.com' })
    );
    await user.type(screen.getByLabelText('Nuova password per student@example.com'), 'g1ovann1');
    await user.click(screen.getByRole('button', { name: 'Salva password' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Aggiornamento rifiutato.');
    expect(screen.getByLabelText('Nuova password per student@example.com')).toHaveValue('g1ovann1');
    expect(screen.queryByText('Password aggiornata.')).toBeNull();
  });

  test('preserves an unsaved model draft after updating a user', async () => {
    const user = userEvent.setup();
    render(<AdminPanel />);
    await openConfiguration(user);
    await openProviderSections(user);

    const lessonModel = screen.getByLabelText('Modello Lezioni per OpenRouter');
    await user.clear(lessonModel);
    await user.type(lessonModel, 'draft/lesson-model');
    await user.click(screen.getByRole('button', { name: 'Utenti' }));
    await user.selectOptions(
      await screen.findByRole('combobox', { name: 'Ruolo per student@example.com' }),
      'admin'
    );
    await waitFor(() => expect(updateAdminUser).toHaveBeenCalledWith('user-1', { role: 'admin' }));

    await user.click(screen.getByRole('button', { name: 'Configurazione' }));
    await openProviderSections(user);
    expect(screen.getByLabelText('Modello Lezioni per OpenRouter')).toHaveValue(
      'draft/lesson-model'
    );
  });

  test('shows the magic-link destination and prevents duplicate sends while pending', async () => {
    const user = userEvent.setup();
    const sendRequest = createDeferred<'access'>();
    vi.mocked(sendAdminMagicLink).mockReturnValue(sendRequest.promise);
    render(<AdminPanel />);

    const button = await screen.findByRole('button', {
      name: 'Invia link di accesso a student@example.com',
    });
    await user.click(button);

    expect(sendAdminMagicLink).toHaveBeenCalledWith('user-1');
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent('Invio in corso…');

    await act(async () => sendRequest.resolve('access'));
    expect(screen.getByRole('status')).toHaveTextContent(
      'Link di accesso inviato a student@example.com. La password esistente non è stata modificata.'
    );
    expect(button).toBeEnabled();
  });

  test('labels and reports setup delivery truthfully for a pending invited user', async () => {
    const user = userEvent.setup();
    vi.mocked(listAdminUsers).mockResolvedValue({
      hasMore: false,
      page: 1,
      pageSize: 8,
      users: [
        {
          id: 'pending-user',
          email: 'pending@example.com',
          app_metadata: { password_setup_required: true, role: 'user' },
        },
      ],
    });
    vi.mocked(sendAdminMagicLink).mockResolvedValue('setup');
    render(<AdminPanel />);

    await user.click(
      await screen.findByRole('button', {
        name: 'Invia link per completare l’account a pending@example.com',
      })
    );

    expect(await screen.findByRole('status')).toHaveTextContent(
      'Link per completare l’account inviato a pending@example.com. Dovrà scegliere una password prima di entrare.'
    );
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

  test('paginates users without hiding their management actions', async () => {
    const user = userEvent.setup();
    vi.mocked(listAdminUsers)
      .mockResolvedValueOnce({
        hasMore: true,
        page: 1,
        pageSize: 8,
        users: Array.from({ length: 8 }, (_, index) => ({
          id: `user-${index + 1}`,
          email: `student${index + 1}@example.com`,
          app_metadata: { role: 'user' },
        })),
      })
      .mockResolvedValueOnce({
        hasMore: false,
        page: 2,
        pageSize: 8,
        users: [
          {
            id: 'user-9',
            email: 'student9@example.com',
            app_metadata: { role: 'user' },
          },
        ],
      });
    render(<AdminPanel />);

    expect(await screen.findByText('student1@example.com')).toBeInTheDocument();
    expect(screen.queryByText('student9@example.com')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Pagina successiva' }));

    expect(await screen.findByText('student9@example.com')).toBeInTheDocument();
    expect(listAdminUsers).toHaveBeenLastCalledWith(2, 8);
    expect(screen.getByRole('button', { name: /Invia link di accesso a student9/ })).toBeEnabled();
  });

  test('shows feedback diagnostics and retries failed GitHub delivery', async () => {
    const user = userEvent.setup();
    vi.mocked(listAdminFeedback).mockResolvedValue({
      page: 1,
      pageSize: 10,
      total: 1,
      reports: [
        {
          attemptCount: 2,
          category: 'bug',
          createdAt: '2026-07-16T10:00:00.000Z',
          description: 'La lezione si blocca dopo il salvataggio.',
          diagnostics: {
            consoleEntries: [
              { level: 'error', message: '[Nous] save failed', timestamp: '2026-07-16T10:00:00Z' },
            ],
            pageUrl: 'https://nous.test/course/123',
            requestId: 'request-123',
          },
          githubLabels: [],
          hasScreenshot: false,
          id: 'feedback-1',
          reporterEmail: 'student@example.com',
          source: 'app',
          status: 'failed',
          updatedAt: '2026-07-16T10:05:00.000Z',
        },
      ],
    });
    render(<AdminPanel />);
    await screen.findByText('student@example.com');

    await user.click(screen.getByRole('button', { name: 'Segnalazioni' }));
    expect(
      (await screen.findAllByText('La lezione si blocca dopo il salvataggio.')).length
    ).toBeGreaterThan(0);
    expect(screen.getByText('request-123')).toBeInTheDocument();
    await user.click(screen.getByText(/Log della console/));
    expect(screen.getByText(/save failed/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Riprova pubblicazione' }));

    await waitFor(() => expect(retryAdminFeedback).toHaveBeenCalledWith('feedback-1'));
    expect(await screen.findByRole('status')).toHaveTextContent('Segnalazione rimessa in coda.');
  });

  test('shows a stable screenshot error instead of an endless placeholder', async () => {
    const user = userEvent.setup();
    vi.mocked(loadAdminFeedbackScreenshot).mockRejectedValue(new Error('private storage detail'));
    vi.mocked(listAdminFeedback).mockResolvedValue({
      page: 1,
      pageSize: 10,
      total: 1,
      reports: [
        {
          attemptCount: 0,
          category: 'bug',
          createdAt: '2026-07-16T10:00:00.000Z',
          description: 'La pagina si rompe.',
          diagnostics: {},
          githubLabels: [],
          hasScreenshot: true,
          id: 'feedback-with-screenshot',
          source: 'app',
          status: 'pending',
          updatedAt: '2026-07-16T10:00:00.000Z',
        },
      ],
    });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    render(<AdminPanel />);

    await user.click(await screen.findByRole('button', { name: 'Segnalazioni' }));

    expect(await screen.findByText('Screenshot non disponibile.')).toBeInTheDocument();
    expect(screen.queryByText('private storage detail')).toBeNull();
  });
});
