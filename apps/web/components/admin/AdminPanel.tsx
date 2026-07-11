import { ArrowLeft, KeyRound, Link2, Plus, RefreshCw, Save, ShieldCheck } from 'lucide-react';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { translateUiMessage as t } from '../../i18n/uiMessages.ts';
import {
  type AdminModelConfig,
  type AdminReasoningEffort,
  type AdminUser,
  createAdminUser,
  DEFAULT_ADMIN_MODEL_CONFIG,
  getAdminModelConfig,
  listAdminUsers,
  patchAdminModelConfig,
  sendAdminMagicLink,
  updateAdminUser,
} from '../../services/admin/adminApi.ts';

const getUserRole = (user: AdminUser): 'admin' | 'user' =>
  user.app_metadata?.role === 'admin' ? 'admin' : 'user';

const isDisabledUser = (user: AdminUser): boolean => Boolean(user.banned_until);

const REASONING_OPTIONS = [
  ['none', 'Nessuno / non supportato'],
  ['low', 'Low'],
  ['medium', 'Medium'],
  ['high', 'High'],
] as const satisfies ReadonlyArray<readonly [AdminReasoningEffort, string]>;

export default function AdminPanel() {
  const modelFields = [
    ['lessonModel', 'lessonReasoningEffort', t('Lezioni')],
    ['contextModel', 'contextReasoningEffort', t('Contesto')],
    ['assessmentModel', 'assessmentReasoningEffort', 'Assessment'],
    ['progressModel', 'progressReasoningEffort', t('Avanzamento')],
  ] as const;
  const openAiModelFields = [
    ['openAiLessonModel', t('Lezioni')],
    ['openAiContextModel', t('Contesto')],
    ['openAiAssessmentModel', 'Assessment'],
    ['openAiProgressModel', t('Avanzamento')],
    ['openAiResearchModel', t('Ricerca')],
    ['openAiImageModel', t('Immagini')],
  ] as const;
  const codexModelFields = [
    ['codexLessonModel', t('Lezioni')],
    ['codexContextModel', t('Contesto')],
    ['codexAssessmentModel', 'Assessment'],
    ['codexProgressModel', t('Avanzamento')],
    ['codexResearchModel', t('Ricerca')],
  ] as const;
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [modelConfig, setModelConfig] = useState<AdminModelConfig>(DEFAULT_ADMIN_MODEL_CONFIG);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [passwordDraft, setPasswordDraft] = useState('');
  const [passwordEditorUserId, setPasswordEditorUserId] = useState<string | null>(null);
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
      await createAdminUser({ email, password, role });
      setEmail('');
      setPassword('');
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

  const handleUserPatch = async (
    user: AdminUser,
    patch: { disabled?: boolean; password?: string; role?: 'admin' | 'user' }
  ) => {
    setErrorMessage('');
    try {
      await updateAdminUser(user.id, patch);
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
              <button
                type="submit"
                className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-full bg-gray-950 px-4 py-2 text-sm font-semibold text-white"
              >
                <Plus className="h-4 w-4" />
                {t('Crea')}
              </button>
            </form>

            <div className="rounded-lg border border-gray-200 bg-white p-4">
              <h2 className="text-sm font-semibold">{t('Modelli globali')}</h2>
              <label className="mt-4 block">
                <span className="text-xs font-semibold uppercase tracking-[0.12em] text-gray-500">
                  {t('Provider AI attivo')}
                </span>
                <select
                  value={modelConfig.aiProvider}
                  onChange={event =>
                    setModelConfig(current => ({
                      ...current,
                      aiProvider:
                        event.target.value === 'codex'
                          ? 'codex'
                          : event.target.value === 'openai'
                            ? 'openai'
                            : 'openrouter',
                    }))
                  }
                  className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"
                >
                  <option value="openrouter">OpenRouter</option>
                  <option value="openai">OpenAI API</option>
                  <option value="codex">Codex app-server</option>
                </select>
              </label>
              <h3 className="mt-5 text-xs font-semibold uppercase tracking-[0.12em] text-gray-500">
                OpenRouter
              </h3>
              {modelFields.map(([modelKey, reasoningKey, rawLabel]) => {
                const label = rawLabel;
                return (
                  <div
                    key={modelKey}
                    className="mt-4 border-b border-gray-100 pb-4 last:border-b-0"
                  >
                    <label className="block">
                      <span className="text-xs font-semibold uppercase tracking-[0.12em] text-gray-500">
                        {label}
                      </span>
                      <input
                        value={modelConfig[modelKey]}
                        onChange={event =>
                          setModelConfig(current => ({
                            ...current,
                            [modelKey]: event.target.value,
                          }))
                        }
                        className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                      />
                    </label>
                    <label className="mt-2 block">
                      <span className="text-xs font-medium text-gray-500">
                        {t('Forza di ragionamento')}
                      </span>
                      <select
                        aria-label={t('Ragionamento {modelSlot}', { modelSlot: label })}
                        value={modelConfig[reasoningKey]}
                        onChange={event =>
                          setModelConfig(current => ({
                            ...current,
                            [reasoningKey]: event.target.value as AdminReasoningEffort,
                          }))
                        }
                        className="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm"
                      >
                        {REASONING_OPTIONS.map(([value, optionLabel]) => (
                          <option key={value} value={value}>
                            {t(optionLabel)}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                );
              })}
              <label className="mt-3 block">
                <span className="text-xs font-semibold uppercase tracking-[0.12em] text-gray-500">
                  {t('Ricerca')}
                </span>
                <input
                  value={modelConfig.researchModel}
                  onChange={event =>
                    setModelConfig(current => ({
                      ...current,
                      researchModel: event.target.value,
                    }))
                  }
                  className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                />
              </label>
              <label className="mt-3 block">
                <span className="text-xs font-semibold uppercase tracking-[0.12em] text-gray-500">
                  {t('Immagini OpenRouter')}
                </span>
                <input
                  value={modelConfig.imageModel}
                  onChange={event =>
                    setModelConfig(current => ({
                      ...current,
                      imageModel: event.target.value,
                    }))
                  }
                  className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                />
              </label>
              {(
                [
                  ['ttsModel', t('TTS')],
                  ['ttsVoice', t('Voce')],
                ] as const satisfies ReadonlyArray<readonly ['ttsModel' | 'ttsVoice', string]>
              ).map(([key, label]) => (
                <label key={key} className="mt-3 block">
                  <span className="text-xs font-semibold uppercase tracking-[0.12em] text-gray-500">
                    {label}
                  </span>
                  <input
                    value={modelConfig[key]}
                    onChange={event =>
                      setModelConfig(current => ({ ...current, [key]: event.target.value }))
                    }
                    className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  />
                </label>
              ))}
              <h3 className="mt-5 border-t border-gray-100 pt-4 text-xs font-semibold uppercase tracking-[0.12em] text-gray-500">
                OpenAI API
              </h3>
              {openAiModelFields.map(([key, label]) => (
                <label key={key} className="mt-3 block">
                  <span className="text-xs font-semibold uppercase tracking-[0.12em] text-gray-500">
                    {label}
                  </span>
                  <input
                    value={modelConfig[key]}
                    onChange={event =>
                      setModelConfig(current => ({ ...current, [key]: event.target.value }))
                    }
                    className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  />
                </label>
              ))}
              <h3 className="mt-5 border-t border-gray-100 pt-4 text-xs font-semibold uppercase tracking-[0.12em] text-gray-500">
                Codex app-server
              </h3>
              {codexModelFields.map(([key, label]) => (
                <label key={key} className="mt-3 block">
                  <span className="text-xs font-semibold uppercase tracking-[0.12em] text-gray-500">
                    {label}
                  </span>
                  <input
                    value={modelConfig[key]}
                    onChange={event =>
                      setModelConfig(current => ({ ...current, [key]: event.target.value }))
                    }
                    className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  />
                </label>
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
