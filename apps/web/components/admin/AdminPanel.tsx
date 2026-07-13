import {
  ArrowLeft,
  BookOpen,
  BrainCircuit,
  ClipboardCheck,
  Image,
  KeyRound,
  Link2,
  type LucideIcon,
  MessageSquareText,
  Mic,
  Plus,
  RefreshCw,
  Save,
  Search,
  Shapes,
  ShieldCheck,
  TrendingUp,
  Volume2,
} from 'lucide-react';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { translateUiMessage as t } from '../../i18n/uiMessages.ts';
import {
  type AdminAiProvider,
  type AdminModelConfig,
  type AdminReasoningEffort,
  type AdminUser,
  type AdminUserPatch,
  createAdminUser,
  DEFAULT_ADMIN_MODEL_CONFIG,
  getAdminModelConfig,
  listAdminUsers,
  patchAdminModelConfig,
  sendAdminMagicLink,
  updateAdminUser,
} from '../../services/admin/adminApi.ts';
import { readSupabaseSession, refreshSupabaseSession } from '../../services/auth/supabaseAuth.ts';
import CodexConnectionSettings from './CodexConnectionSettings.tsx';

const getUserRole = (user: AdminUser): 'admin' | 'user' =>
  user.app_metadata?.role === 'admin' ? 'admin' : 'user';

const isDisabledUser = (user: AdminUser): boolean => Boolean(user.banned_until);

const AI_PROVIDER_OPTIONS = [
  ['openrouter', 'OpenRouter'],
  ['openai', 'OpenAI API'],
  ['codex', 'Codex app-server'],
] as const satisfies ReadonlyArray<readonly [AdminAiProvider, string]>;

type UserAiProviderSelection = AdminAiProvider | 'default';

const readAiProvider = (value: string): AdminAiProvider =>
  value === 'codex' ? 'codex' : value === 'openai' ? 'openai' : 'openrouter';

const readUserAiProvider = (value: string): UserAiProviderSelection =>
  value === 'default' ? 'default' : readAiProvider(value);

const getUserAiProvider = (user: AdminUser): UserAiProviderSelection =>
  user.app_metadata?.ai_provider || 'default';

const REASONING_OPTIONS = [
  ['none', 'None'],
  ['minimal', 'Minimal'],
  ['low', 'Low'],
  ['medium', 'Medium'],
  ['high', 'High'],
] as const satisfies ReadonlyArray<readonly [AdminReasoningEffort, string]>;

type AdminTextModelKey =
  | 'artifactModel'
  | 'artifactInteractiveModel'
  | 'assessmentModel'
  | 'codexArtifactModel'
  | 'codexArtifactInteractiveModel'
  | 'codexAssessmentModel'
  | 'codexContextModel'
  | 'codexLessonModel'
  | 'codexProgressModel'
  | 'codexResearchModel'
  | 'contextModel'
  | 'lessonModel'
  | 'openAiArtifactModel'
  | 'openAiArtifactInteractiveModel'
  | 'openAiAssessmentModel'
  | 'openAiContextModel'
  | 'openAiLessonModel'
  | 'openAiProgressModel'
  | 'openAiResearchModel'
  | 'progressModel'
  | 'researchModel';

type AdminReasoningKey =
  | 'artifactReasoningEffort'
  | 'artifactInteractiveReasoningEffort'
  | 'assessmentReasoningEffort'
  | 'contextReasoningEffort'
  | 'lessonReasoningEffort'
  | 'progressReasoningEffort';

const TEXT_MODEL_LABELS = {
  artifacts: () => t('Artefatti visuali'),
  interactiveArtifacts: () => t('Artefatti interattivi'),
  assessment: () => 'Assessment',
  context: () => t('Contesto'),
  lessons: () => t('Lezioni'),
  progress: () => t('Avanzamento'),
  research: () => t('Ricerca'),
} as const;

const TEXT_MODEL_ROWS: ReadonlyArray<{
  icon: LucideIcon;
  labelKey: keyof typeof TEXT_MODEL_LABELS;
  models: Record<AdminAiProvider, AdminTextModelKey>;
  reasoning?: AdminReasoningKey;
}> = [
  {
    icon: Shapes,
    labelKey: 'artifacts',
    models: {
      openrouter: 'artifactModel',
      openai: 'openAiArtifactModel',
      codex: 'codexArtifactModel',
    },
    reasoning: 'artifactReasoningEffort',
  },
  {
    icon: BrainCircuit,
    labelKey: 'interactiveArtifacts',
    models: {
      openrouter: 'artifactInteractiveModel',
      openai: 'openAiArtifactInteractiveModel',
      codex: 'codexArtifactInteractiveModel',
    },
    reasoning: 'artifactInteractiveReasoningEffort',
  },
  {
    icon: BookOpen,
    labelKey: 'lessons',
    models: {
      openrouter: 'lessonModel',
      openai: 'openAiLessonModel',
      codex: 'codexLessonModel',
    },
    reasoning: 'lessonReasoningEffort',
  },
  {
    icon: MessageSquareText,
    labelKey: 'context',
    models: {
      openrouter: 'contextModel',
      openai: 'openAiContextModel',
      codex: 'codexContextModel',
    },
    reasoning: 'contextReasoningEffort',
  },
  {
    icon: ClipboardCheck,
    labelKey: 'assessment',
    models: {
      openrouter: 'assessmentModel',
      openai: 'openAiAssessmentModel',
      codex: 'codexAssessmentModel',
    },
    reasoning: 'assessmentReasoningEffort',
  },
  {
    icon: TrendingUp,
    labelKey: 'progress',
    models: {
      openrouter: 'progressModel',
      openai: 'openAiProgressModel',
      codex: 'codexProgressModel',
    },
    reasoning: 'progressReasoningEffort',
  },
  {
    icon: Search,
    labelKey: 'research',
    models: {
      openrouter: 'researchModel',
      openai: 'openAiResearchModel',
      codex: 'codexResearchModel',
    },
  },
];

const PROVIDER_SECTIONS: ReadonlyArray<{
  id: AdminAiProvider;
  label: string;
}> = [
  { id: 'openrouter', label: 'OpenRouter' },
  { id: 'openai', label: 'OpenAI API' },
  { id: 'codex', label: 'Codex app-server' },
];

export default function AdminPanel() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [modelConfig, setModelConfig] = useState<AdminModelConfig>(DEFAULT_ADMIN_MODEL_CONFIG);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [passwordDraft, setPasswordDraft] = useState('');
  const [passwordEditorUserId, setPasswordEditorUserId] = useState<string | null>(null);
  const [newUserAiProvider, setNewUserAiProvider] = useState<UserAiProviderSelection>('default');
  const [role, setRole] = useState<'admin' | 'user'>('user');
  const [statusMessage, setStatusMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isSavingModels, setIsSavingModels] = useState(false);

  const loadAdminData = useCallback(async () => {
    setIsLoading(true);
    setErrorMessage('');
    try {
      const [nextUsers, nextModelConfig] = await Promise.all([
        listAdminUsers(),
        getAdminModelConfig(),
      ]);
      setUsers(nextUsers);
      setModelConfig(nextModelConfig);
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : t('Pannello admin non disponibile.')
      );
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    queueMicrotask(() => {
      void loadAdminData();
    });
  }, [loadAdminData]);

  const handleCreateUser = async (event: FormEvent) => {
    event.preventDefault();
    setErrorMessage('');
    try {
      await createAdminUser({
        email,
        password,
        role,
        ...(newUserAiProvider === 'default' ? {} : { aiProvider: newUserAiProvider }),
      });
      setEmail('');
      setPassword('');
      setNewUserAiProvider('default');
      setRole('user');
      setStatusMessage(t('Account creato.'));
      await loadAdminData();
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : t('Creazione account non riuscita.')
      );
    }
  };

  const handleModelSave = async () => {
    setErrorMessage('');
    setStatusMessage('');
    setIsSavingModels(true);
    try {
      setModelConfig(await patchAdminModelConfig(modelConfig));
      setStatusMessage(t('Modelli aggiornati.'));
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : t('Salvataggio modelli non riuscito.')
      );
    } finally {
      setIsSavingModels(false);
    }
  };

  const handleUserPatch = async (user: AdminUser, patch: AdminUserPatch) => {
    setErrorMessage('');
    try {
      await updateAdminUser(user.id, patch);
      if ('aiProvider' in patch && readSupabaseSession()?.user?.id === user.id) {
        await refreshSupabaseSession();
      }
      await loadAdminData();
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : t('Aggiornamento utente non riuscito.')
      );
    }
  };

  const handlePasswordSave = async (user: AdminUser) => {
    const nextPassword = passwordDraft.trim();
    if (!nextPassword) {
      setErrorMessage(t('Inserisci una password.'));
      return;
    }

    await handleUserPatch(user, { password: nextPassword });
    setPasswordDraft('');
    setPasswordEditorUserId(null);
    setStatusMessage(t('Password aggiornata.'));
  };

  const renderTextModelRow = (provider: AdminAiProvider, row: (typeof TEXT_MODEL_ROWS)[number]) => {
    const Icon = row.icon;
    const label = TEXT_MODEL_LABELS[row.labelKey]();
    const modelKey = row.models[provider];

    return (
      <div key={modelKey} className="border-b border-gray-100 py-3 last:border-b-0">
        <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-gray-800">
          <Icon className="h-4 w-4 shrink-0 text-gray-500" />
          <span>{label}</span>
        </div>
        <div className="grid grid-cols-[minmax(0,7fr)_minmax(6.5rem,3fr)] gap-2">
          <label className="min-w-0">
            <span className="sr-only">{t('Modello {modelSlot}', { modelSlot: label })}</span>
            <input
              value={modelConfig[modelKey]}
              onChange={event =>
                setModelConfig(current => ({ ...current, [modelKey]: event.target.value }))
              }
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
          </label>
          <label className="min-w-0">
            <span className="sr-only">{t('Ragionamento {modelSlot}', { modelSlot: label })}</span>
            <select
              aria-label={t('Ragionamento {modelSlot}', { modelSlot: label })}
              value={row.reasoning ? modelConfig[row.reasoning] : 'none'}
              disabled={!row.reasoning}
              onChange={event => {
                const reasoningKey = row.reasoning;
                if (!reasoningKey) return;
                setModelConfig(current => ({
                  ...current,
                  [reasoningKey]: event.target.value as AdminReasoningEffort,
                }));
              }}
              className="w-full rounded-lg border border-gray-300 bg-white px-2 py-2 text-sm disabled:bg-gray-50 disabled:text-gray-500"
            >
              {row.reasoning ? (
                REASONING_OPTIONS.map(([value, optionLabel]) => (
                  <option key={value} value={value}>
                    {t(optionLabel)}
                  </option>
                ))
              ) : (
                <option value="none">{t('Nessuno')}</option>
              )}
            </select>
          </label>
        </div>
      </div>
    );
  };

  const renderSingleModelRow = ({
    icon: Icon,
    label,
    modelKey,
  }: {
    icon: LucideIcon;
    label: string;
    modelKey: 'imageModel' | 'openAiImageModel' | 'ttsModel' | 'ttsVoice';
  }) => (
    <label className="block border-b border-gray-100 py-3 last:border-b-0">
      <span className="mb-2 flex items-center gap-2 text-sm font-semibold text-gray-800">
        <Icon className="h-4 w-4 shrink-0 text-gray-500" />
        {label}
      </span>
      <input
        value={modelConfig[modelKey]}
        onChange={event =>
          setModelConfig(current => ({ ...current, [modelKey]: event.target.value }))
        }
        className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
      />
    </label>
  );

  return (
    <main className="min-h-screen bg-[#f8f7f4] px-4 py-6 text-gray-950">
      <div className="mx-auto max-w-6xl">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-200 pb-4">
          <div>
            <a href="/" className="inline-flex items-center gap-2 text-sm text-gray-600">
              <ArrowLeft className="h-4 w-4" />
              {t('Libreria')}
            </a>
            <h1 className="mt-2 font-serif text-3xl">{t('Amministrazione')}</h1>
          </div>
          <button
            type="button"
            onClick={() => void loadAdminData()}
            className="inline-flex items-center gap-2 rounded-full border border-gray-300 bg-white px-4 py-2 text-sm font-semibold"
          >
            <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
            {t('Aggiorna')}
          </button>
        </header>

        {errorMessage ? (
          <p role="alert" className="mt-4 text-sm text-red-600">
            {errorMessage}
          </p>
        ) : null}
        {statusMessage ? (
          <output className="mt-4 block text-sm text-gray-600">{statusMessage}</output>
        ) : null}

        <section className="mt-6 grid gap-6 lg:grid-cols-[1fr_22rem]">
          <div>
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-5 w-5" />
              <h2 className="text-lg font-semibold">{t('Utenti')}</h2>
            </div>
            <div className="mt-3 overflow-hidden rounded-lg border border-gray-200 bg-white">
              {users.map(user => (
                <div
                  key={user.id}
                  className="grid gap-3 border-b border-gray-100 p-4 last:border-b-0 sm:grid-cols-[1fr_auto]"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold">{user.email || user.id}</p>
                    <p className="mt-1 text-xs text-gray-500">
                      {getUserRole(user)} · {t(isDisabledUser(user) ? 'disabilitato' : 'attivo')}
                    </p>
                    <label className="mt-2 flex w-fit items-center gap-2 text-xs text-gray-500">
                      <span>{t('Provider AI')}</span>
                      <select
                        aria-label={t('Provider AI per {userName}', {
                          userName: user.email || user.id,
                        })}
                        value={getUserAiProvider(user)}
                        onChange={event => {
                          const provider = readUserAiProvider(event.target.value);
                          void handleUserPatch(user, {
                            aiProvider: provider === 'default' ? null : provider,
                          });
                        }}
                        className="rounded-lg border border-gray-300 bg-white px-2 py-1 text-xs text-gray-700"
                      >
                        <option value="default">{t('Predefinito globale')}</option>
                        {AI_PROVIDER_OPTIONS.map(([value, label]) => (
                          <option key={value} value={value}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => void sendAdminMagicLink(user.id)}
                      className="inline-flex items-center gap-1.5 rounded-full border border-gray-300 px-3 py-1.5 text-xs font-semibold"
                    >
                      <Link2 className="h-3.5 w-3.5" />
                      Magic link
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        void handleUserPatch(user, {
                          role: getUserRole(user) === 'admin' ? 'user' : 'admin',
                        })
                      }
                      className="rounded-full border border-gray-300 px-3 py-1.5 text-xs font-semibold"
                    >
                      {getUserRole(user) === 'admin' ? t('Base') : 'Admin'}
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        void handleUserPatch(user, { disabled: !isDisabledUser(user) })
                      }
                      className="rounded-full border border-gray-300 px-3 py-1.5 text-xs font-semibold"
                    >
                      {t(isDisabledUser(user) ? 'Abilita' : 'Disabilita')}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setPasswordDraft('');
                        setPasswordEditorUserId(currentUserId =>
                          currentUserId === user.id ? null : user.id
                        );
                      }}
                      className="inline-flex items-center gap-1.5 rounded-full border border-gray-300 px-3 py-1.5 text-xs font-semibold"
                    >
                      <KeyRound className="h-3.5 w-3.5" />
                      Password
                    </button>
                  </div>
                  {passwordEditorUserId === user.id ? (
                    <div className="sm:col-span-2 flex flex-wrap items-center gap-2 rounded-lg border border-gray-200 bg-gray-50 p-3">
                      <input
                        type="password"
                        aria-label={t('Nuova password per {userName}', {
                          userName: user.email || user.id,
                        })}
                        value={passwordDraft}
                        onChange={event => setPasswordDraft(event.target.value)}
                        className="min-w-[14rem] flex-1 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"
                      />
                      <button
                        type="button"
                        onClick={() => void handlePasswordSave(user)}
                        className="rounded-full bg-gray-950 px-4 py-2 text-xs font-semibold text-white"
                      >
                        {t('Salva password')}
                      </button>
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          </div>

          <aside className="space-y-6">
            <form
              onSubmit={handleCreateUser}
              className="rounded-lg border border-gray-200 bg-white p-4"
            >
              <h2 className="text-sm font-semibold">{t('Crea account')}</h2>
              <input
                type="email"
                aria-label={t('Email nuovo account')}
                placeholder="email"
                value={email}
                onChange={event => setEmail(event.target.value)}
                className="mt-3 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                required
              />
              <input
                type="password"
                aria-label={t('Password nuovo account')}
                placeholder="password"
                value={password}
                onChange={event => setPassword(event.target.value)}
                className="mt-2 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                required
              />
              <select
                aria-label={t('Ruolo nuovo account')}
                value={role}
                onChange={event => setRole(event.target.value === 'admin' ? 'admin' : 'user')}
                className="mt-2 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
              >
                <option value="user">{t('Base')}</option>
                <option value="admin">Admin</option>
              </select>
              <select
                aria-label={t('Provider AI nuovo account')}
                value={newUserAiProvider}
                onChange={event => setNewUserAiProvider(readUserAiProvider(event.target.value))}
                className="mt-2 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"
              >
                <option value="default">{t('Predefinito globale')}</option>
                {AI_PROVIDER_OPTIONS.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
              <button
                type="submit"
                className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-full bg-gray-950 px-4 py-2 text-sm font-semibold text-white"
              >
                <Plus className="h-4 w-4" />
                {t('Crea')}
              </button>
            </form>

            <CodexConnectionSettings />

            <div className="rounded-lg border border-gray-200 bg-white p-4">
              <h2 className="flex items-center gap-2 text-sm font-semibold">
                <BrainCircuit className="h-4 w-4 text-gray-500" />
                {t('Modelli globali')}
              </h2>
              <label className="mt-4 block">
                <span className="flex items-center gap-2 text-sm font-semibold text-gray-800">
                  <Link2 className="h-4 w-4 text-gray-500" />
                  {t('Provider AI attivo')}
                </span>
                <select
                  value={modelConfig.aiProvider}
                  onChange={event =>
                    setModelConfig(current => ({
                      ...current,
                      aiProvider: readAiProvider(event.target.value),
                    }))
                  }
                  className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"
                >
                  {AI_PROVIDER_OPTIONS.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="mt-4 flex items-start gap-3 rounded-lg border border-gray-200 px-3 py-3">
                <input
                  type="checkbox"
                  aria-label={t('Revisione visiva degli artefatti')}
                  checked={modelConfig.artifactVisualReviewEnabled}
                  onChange={event =>
                    setModelConfig(current => ({
                      ...current,
                      artifactVisualReviewEnabled: event.target.checked,
                    }))
                  }
                  className="mt-0.5 h-4 w-4 rounded border-gray-300"
                />
                <span>
                  <span className="block text-sm font-semibold text-gray-800">
                    {t('Revisione visiva degli artefatti')}
                  </span>
                  <span className="mt-1 block text-xs leading-5 text-gray-500">
                    {t('Aggiunge un secondo passaggio di controllo dopo la prima generazione.')}
                  </span>
                </span>
              </label>
              <label className="mt-3 block">
                <span className="text-sm font-semibold text-gray-800">
                  {t('Round massimi di revisione')}
                </span>
                <input
                  type="number"
                  min={1}
                  max={4}
                  disabled={!modelConfig.artifactVisualReviewEnabled}
                  value={modelConfig.artifactVisualReviewMaxRounds}
                  onChange={event =>
                    setModelConfig(current => ({
                      ...current,
                      artifactVisualReviewMaxRounds: Math.min(
                        4,
                        Math.max(1, Number.parseInt(event.target.value, 10) || 1)
                      ),
                    }))
                  }
                  className="mt-1 w-24 rounded-lg border border-gray-300 px-3 py-2 text-sm disabled:bg-gray-50 disabled:text-gray-400"
                />
              </label>
              <div className="mt-5 border-t border-gray-200 pt-4">
                {renderSingleModelRow({
                  icon: Image,
                  label: t('Immagini (Codex/OpenAI)'),
                  modelKey: 'openAiImageModel',
                })}
              </div>
              {PROVIDER_SECTIONS.map(({ id, label }) => (
                <section key={id} className="mt-5 border-t border-gray-200 pt-4 first:border-t-0">
                  <h3 className="flex items-center gap-2 text-sm font-semibold text-gray-950">
                    <BrainCircuit className="h-4 w-4 text-gray-500" />
                    {label}
                  </h3>
                  <div className="mt-1">
                    {TEXT_MODEL_ROWS.map(row => renderTextModelRow(id, row))}
                  </div>
                  {id === 'openrouter' ? (
                    <>
                      {renderSingleModelRow({
                        icon: Image,
                        label: t('Immagini'),
                        modelKey: 'imageModel',
                      })}
                      {renderSingleModelRow({
                        icon: Volume2,
                        label: t('TTS'),
                        modelKey: 'ttsModel',
                      })}
                      {renderSingleModelRow({
                        icon: Mic,
                        label: t('Voce'),
                        modelKey: 'ttsVoice',
                      })}
                    </>
                  ) : null}
                </section>
              ))}
              <p className="mt-2 text-xs leading-5 text-gray-500">
                {t(
                  'La forza di ragionamento è condivisa per funzione; i modelli restano separati per provider. TTS e immagini non usano reasoning.'
                )}
              </p>
              <button
                type="button"
                onClick={() => void handleModelSave()}
                disabled={isSavingModels}
                aria-busy={isSavingModels}
                className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-full bg-gray-950 px-4 py-2 text-sm font-semibold text-white disabled:cursor-wait disabled:opacity-60"
              >
                <Save className="h-4 w-4" />
                {t('Salva modelli')}
              </button>
            </div>
          </aside>
        </section>
      </div>
    </main>
  );
}
