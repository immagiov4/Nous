import {
  ArrowLeft,
  BookOpen,
  BrainCircuit,
  ChevronLeft,
  ChevronRight,
  ClipboardCheck,
  Flag,
  FlaskConical,
  GraduationCap,
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
  Settings2,
  Shapes,
  ShieldCheck,
  TrendingUp,
  UsersRound,
  Volume2,
} from 'lucide-react';
import { type SyntheticEvent, useCallback, useEffect, useState } from 'react';
import { translateUiMessage as t } from '../../i18n/uiMessages.ts';
import {
  type AdminAccessEmailDelivery,
  type AdminAiProvider,
  type AdminModelConfig,
  type AdminModelProviderOverrides,
  type AdminModelProviderSlot,
  type AdminReasoningEffort,
  type AdminUser,
  type AdminUserPatch,
  createAdminUser,
  DEFAULT_ADMIN_MODEL_CONFIG,
  getAdminModelConfig,
  listAdminUsers,
  patchAdminModelConfig,
  sendAdminAccessEmail,
  sendAdminMagicLink,
  updateAdminUser,
} from '../../services/admin/adminApi.ts';
import { readSupabaseSession, refreshSupabaseSession } from '../../services/auth/supabaseAuth.ts';
import AdminDisclosure from './AdminDisclosure.tsx';
import AdminFeedbackPanel from './AdminFeedbackPanel.tsx';
import CodexConnectionSettings from './CodexConnectionSettings.tsx';
import CourseCoverRegenerationControl from './CourseCoverRegenerationControl.tsx';

type AdminSection = 'configuration' | 'feedback' | 'users';

const USERS_PER_PAGE = 8;
const adminFieldClassName =
  'w-full rounded-xl border border-stone-300 bg-white px-3 py-2.5 text-sm text-stone-950 outline-none transition-colors focus:border-orange-500 focus:ring-1 focus:ring-orange-500 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100';

const getUserRole = (user: AdminUser): 'admin' | 'user' =>
  user.app_metadata?.role === 'admin' ? 'admin' : 'user';

const isDisabledUser = (user: AdminUser): boolean => Boolean(user.banned_until);

const getUserAccessEmailActionLabel = (user: AdminUser, includeDestination = false): string => {
  const pendingSetup = user.app_metadata?.password_setup_required === true;
  if (includeDestination) {
    return t(
      pendingSetup
        ? 'Invia link per completare l’account a {userEmail}'
        : 'Invia link di accesso a {userEmail}',
      { userEmail: user.email || user.id }
    );
  }
  return t(pendingSetup ? 'Invia link per completare l’account' : 'Invia link di accesso');
};

const getAccessEmailStatusMessage = (
  delivery: AdminAccessEmailDelivery,
  destination: string
): string => {
  if (delivery === 'invitation') {
    return t('Invito inviato a {userEmail}. Dovrà scegliere una password prima di entrare.', {
      userEmail: destination,
    });
  }
  if (delivery === 'setup') {
    return t(
      'Link per completare l’account inviato a {userEmail}. Dovrà scegliere una password prima di entrare.',
      { userEmail: destination }
    );
  }
  return t('Link di accesso inviato a {userEmail}. La password esistente non è stata modificata.', {
    userEmail: destination,
  });
};

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

const getUserAiProviderOverrides = (user: AdminUser): AdminModelProviderOverrides =>
  user.app_metadata?.ai_provider_overrides || {};

const getUserDefaultAiProvider = (
  user: AdminUser,
  modelConfig: AdminModelConfig,
  slot: AdminModelProviderSlot
): AdminAiProvider =>
  user.app_metadata?.ai_provider || modelConfig.aiProviderOverrides[slot] || modelConfig.aiProvider;

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
  | 'codexCourseModel'
  | 'codexLessonModel'
  | 'codexProgressModel'
  | 'codexResearchModel'
  | 'contextModel'
  | 'courseModel'
  | 'lessonModel'
  | 'openAiArtifactModel'
  | 'openAiArtifactInteractiveModel'
  | 'openAiAssessmentModel'
  | 'openAiContextModel'
  | 'openAiCourseModel'
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
  | 'courseReasoningEffort'
  | 'lessonReasoningEffort'
  | 'progressReasoningEffort'
  | 'researchReasoningEffort';
type AdminTextModelSlot = Exclude<AdminModelProviderSlot, 'image'>;

const TEXT_MODEL_LABELS = {
  artifacts: () => t('Artefatti visuali'),
  interactiveArtifacts: () => t('Artefatti interattivi'),
  assessment: () => 'Assessment',
  context: () => t('Contesto'),
  course: () => t('Corso'),
  lessons: () => t('Lezioni'),
  progress: () => t('Avanzamento'),
  research: () => t('Ricerca'),
} as const;

const TEXT_MODEL_ROWS: ReadonlyArray<{
  icon: LucideIcon;
  labelKey: keyof typeof TEXT_MODEL_LABELS;
  models: Record<AdminAiProvider, AdminTextModelKey>;
  reasoning?: AdminReasoningKey;
  slot: AdminTextModelSlot;
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
    slot: 'artifact',
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
    slot: 'artifactInteractive',
  },
  {
    icon: GraduationCap,
    labelKey: 'course',
    models: {
      openrouter: 'courseModel',
      openai: 'openAiCourseModel',
      codex: 'codexCourseModel',
    },
    reasoning: 'courseReasoningEffort',
    slot: 'course',
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
    slot: 'lesson',
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
    slot: 'context',
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
    slot: 'assessment',
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
    slot: 'progress',
  },
  {
    icon: Search,
    labelKey: 'research',
    models: {
      openrouter: 'researchModel',
      openai: 'openAiResearchModel',
      codex: 'codexResearchModel',
    },
    reasoning: 'researchReasoningEffort',
    slot: 'research',
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

const PROVIDER_OVERRIDE_ROWS: ReadonlyArray<{
  icon: LucideIcon;
  label: () => string;
  slot: AdminModelProviderSlot;
}> = [
  ...TEXT_MODEL_ROWS.map(row => ({
    icon: row.icon,
    label: TEXT_MODEL_LABELS[row.labelKey],
    slot: row.slot,
  })),
  { icon: Image, label: () => t('Immagini'), slot: 'image' },
];

export default function AdminPanel() {
  const [activeSection, setActiveSection] = useState<AdminSection>('users');
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [modelConfig, setModelConfig] = useState<AdminModelConfig>(DEFAULT_ADMIN_MODEL_CONFIG);
  const [accessEmail, setAccessEmail] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [passwordDraft, setPasswordDraft] = useState('');
  const [passwordEditorUserId, setPasswordEditorUserId] = useState<string | null>(null);
  const [newUserAiProvider, setNewUserAiProvider] = useState<UserAiProviderSelection>('default');
  const [role, setRole] = useState<'admin' | 'user'>('user');
  const [statusMessage, setStatusMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [magicLinkUserId, setMagicLinkUserId] = useState<string | null>(null);
  const [isSendingAccessEmail, setIsSendingAccessEmail] = useState(false);
  const [isSavingModels, setIsSavingModels] = useState(false);
  const [isModelConfigLoaded, setIsModelConfigLoaded] = useState(false);
  const [userSearch, setUserSearch] = useState('');
  const [userPage, setUserPage] = useState(1);
  const [userHasMore, setUserHasMore] = useState(false);

  const userQuery = userSearch.trim().toLowerCase();
  const visibleUsers = userQuery
    ? users.filter(user => `${user.email || ''} ${user.id}`.toLowerCase().includes(userQuery))
    : users;

  const loadUsers = useCallback(async (page: number) => {
    const result = await listAdminUsers(page, USERS_PER_PAGE);
    setUsers(result.users);
    setUserHasMore(result.hasMore);
  }, []);

  const loadModelConfig = useCallback(async () => {
    setIsModelConfigLoaded(false);
    const nextModelConfig = await getAdminModelConfig();
    setModelConfig(nextModelConfig);
    setIsModelConfigLoaded(true);
  }, []);

  const loadAdminData = useCallback(async () => {
    setIsLoading(true);
    setErrorMessage('');
    setUserPage(1);
    try {
      await Promise.all([loadUsers(1), loadModelConfig()]);
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : t('Pannello admin non disponibile.')
      );
    } finally {
      setIsLoading(false);
    }
  }, [loadModelConfig, loadUsers]);

  useEffect(() => {
    queueMicrotask(() => {
      void loadAdminData();
    });
  }, [loadAdminData]);

  const createUser = async () => {
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
      await loadUsers(userPage);
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : t('Creazione account non riuscita.')
      );
    }
  };

  const handleCreateUser = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    void createUser();
  };

  const sendAccessEmail = async () => {
    const destination = accessEmail.trim();
    if (!destination) {
      return;
    }

    setErrorMessage('');
    setStatusMessage('');
    setIsSendingAccessEmail(true);
    try {
      const delivery = await sendAdminAccessEmail(destination);
      setAccessEmail('');
      setStatusMessage(getAccessEmailStatusMessage(delivery, destination));
      if (delivery === 'invitation') {
        await loadUsers(userPage);
      }
    } catch {
      setErrorMessage(t("Invio dell'email di accesso non riuscito."));
    } finally {
      setIsSendingAccessEmail(false);
    }
  };

  const handleAccessEmailSend = (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    void sendAccessEmail();
  };

  const handleModelSave = async () => {
    if (!isModelConfigLoaded) {
      return;
    }
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

  const handleUserPatch = async (user: AdminUser, patch: AdminUserPatch): Promise<boolean> => {
    setErrorMessage('');
    try {
      await updateAdminUser(user.id, patch);
      if (
        ('aiProvider' in patch || 'aiProviderOverrides' in patch) &&
        readSupabaseSession()?.user?.id === user.id
      ) {
        await refreshSupabaseSession();
      }
      await loadUsers(userPage);
      return true;
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : t('Aggiornamento utente non riuscito.')
      );
      return false;
    }
  };

  const handleMagicLinkSend = async (user: AdminUser) => {
    setErrorMessage('');
    setStatusMessage('');
    setMagicLinkUserId(user.id);
    try {
      const delivery = await sendAdminMagicLink(user.id);
      setStatusMessage(getAccessEmailStatusMessage(delivery, user.email || user.id));
    } catch {
      setErrorMessage(t('Invio magic link non riuscito.'));
    } finally {
      setMagicLinkUserId(null);
    }
  };

  const handlePasswordSave = async (user: AdminUser) => {
    const nextPassword = passwordDraft.trim();
    if (!nextPassword) {
      setErrorMessage(t('Inserisci una password.'));
      return;
    }

    if (!(await handleUserPatch(user, { password: nextPassword }))) {
      return;
    }
    setPasswordDraft('');
    setPasswordEditorUserId(null);
    setStatusMessage(t('Password aggiornata.'));
  };

  const handleUserPageChange = async (nextPage: number) => {
    setIsLoading(true);
    setErrorMessage('');
    try {
      await loadUsers(nextPage);
      setUserPage(nextPage);
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : t('Caricamento utenti non riuscito.')
      );
    } finally {
      setIsLoading(false);
    }
  };

  const renderProviderOverrideSelect = ({
    defaultProvider,
    label,
    onChange,
    overrides,
    slot,
  }: {
    defaultProvider: AdminAiProvider;
    label: string;
    onChange: (overrides: AdminModelProviderOverrides) => void;
    overrides: AdminModelProviderOverrides;
    slot: AdminModelProviderSlot;
  }) => {
    const Icon =
      PROVIDER_OVERRIDE_ROWS.find(providerSlot => providerSlot.slot === slot)?.icon || Settings2;
    return (
      <label
        key={slot}
        className="rounded-xl border border-stone-200 bg-stone-50/70 p-3 dark:border-zinc-700 dark:bg-zinc-800/40"
      >
        <span className="mb-2 flex items-center gap-2 text-xs font-semibold text-stone-700 dark:text-zinc-200">
          <Icon className="h-3.5 w-3.5 text-stone-500 dark:text-zinc-400" />
          {label}
        </span>
        <select
          aria-label={t('Provider per {modelSlot}', { modelSlot: label })}
          value={overrides[slot] || 'default'}
          onChange={event => {
            const { [slot]: _removed, ...remainingOverrides } = overrides;
            onChange(
              event.target.value === 'default'
                ? remainingOverrides
                : {
                    ...remainingOverrides,
                    [slot]: readAiProvider(event.target.value),
                  }
            );
          }}
          className={`${adminFieldClassName} py-2 text-xs`}
        >
          <option value="default">
            {t('Predefinito: {provider}', {
              provider:
                AI_PROVIDER_OPTIONS.find(([provider]) => provider === defaultProvider)?.[1] ||
                defaultProvider,
            })}
          </option>
          {AI_PROVIDER_OPTIONS.map(([value, providerLabel]) => (
            <option key={value} value={value}>
              {providerLabel}
            </option>
          ))}
        </select>
      </label>
    );
  };

  const renderTextModelRow = (provider: AdminAiProvider, row: (typeof TEXT_MODEL_ROWS)[number]) => {
    const Icon = row.icon;
    const label = TEXT_MODEL_LABELS[row.labelKey]();
    const modelKey = row.models[provider];
    const providerLabel =
      PROVIDER_SECTIONS.find(section => section.id === provider)?.label || provider;

    return (
      <div
        key={modelKey}
        className="border-b border-stone-100 py-3 last:border-b-0 dark:border-zinc-800"
      >
        <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-stone-800 dark:text-zinc-200">
          <Icon className="h-4 w-4 shrink-0 text-stone-500 dark:text-zinc-400" />
          <span>{label}</span>
        </div>
        <div className="grid grid-cols-[minmax(0,7fr)_minmax(6.5rem,3fr)] gap-2">
          <label className="min-w-0">
            <span className="sr-only">
              {t('Modello {modelSlot} per {provider}', {
                modelSlot: label,
                provider: providerLabel,
              })}
            </span>
            <input
              value={modelConfig[modelKey]}
              onChange={event =>
                setModelConfig(current => ({ ...current, [modelKey]: event.target.value }))
              }
              className={adminFieldClassName}
            />
          </label>
          <label className="min-w-0">
            <span className="sr-only">
              {t('Ragionamento {modelSlot} per {provider}', {
                modelSlot: label,
                provider: providerLabel,
              })}
            </span>
            <select
              aria-label={t('Ragionamento {modelSlot} per {provider}', {
                modelSlot: label,
                provider: providerLabel,
              })}
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
              className={`${adminFieldClassName} disabled:bg-stone-100 disabled:text-stone-400 dark:disabled:bg-zinc-800`}
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
        {provider === 'codex' ? (
          <label className="mt-2 flex items-center gap-2 text-sm text-stone-600 dark:text-zinc-300">
            <input
              type="checkbox"
              checked={modelConfig.codexFastModelSlots.includes(row.slot)}
              onChange={event =>
                setModelConfig(current => ({
                  ...current,
                  codexFastModelSlots: event.target.checked
                    ? [...current.codexFastModelSlots, row.slot]
                    : current.codexFastModelSlots.filter(slot => slot !== row.slot),
                }))
              }
              className="h-4 w-4 rounded border-stone-300"
            />
            Modalità Fast
          </label>
        ) : null}
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
    <label className="block border-b border-stone-100 py-3 last:border-b-0 dark:border-zinc-800">
      <span className="mb-2 flex items-center gap-2 text-sm font-semibold text-stone-800 dark:text-zinc-200">
        <Icon className="h-4 w-4 shrink-0 text-stone-500 dark:text-zinc-400" />
        {label}
      </span>
      <input
        value={modelConfig[modelKey]}
        onChange={event =>
          setModelConfig(current => ({ ...current, [modelKey]: event.target.value }))
        }
        className={adminFieldClassName}
      />
    </label>
  );

  return (
    <main className="min-h-screen bg-[#f8f7f4] px-3 py-4 text-stone-950 sm:px-5 sm:py-6 dark:bg-zinc-950 dark:text-zinc-100">
      <div className="mx-auto max-w-7xl">
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-stone-200 pb-5 dark:border-zinc-800">
          <div>
            <a
              href="/"
              className="inline-flex items-center gap-2 text-sm text-stone-600 hover:text-stone-950 dark:text-zinc-400 dark:hover:text-zinc-100"
            >
              <ArrowLeft className="h-4 w-4" />
              {t('Libreria')}
            </a>
            <h1 className="mt-2 font-serif text-3xl sm:text-4xl">{t('Amministrazione')}</h1>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <a
              href="/admin/youtube-lab"
              className="inline-flex items-center gap-2 rounded-full border border-stone-300 bg-white px-4 py-2 text-sm font-semibold transition-colors hover:border-stone-500 dark:border-zinc-700 dark:bg-zinc-900"
            >
              <FlaskConical className="h-4 w-4" />
              YouTube Lab
            </a>
            <button
              type="button"
              onClick={() => void loadAdminData()}
              className="inline-flex items-center gap-2 rounded-full border border-stone-300 bg-white px-4 py-2 text-sm font-semibold transition-colors hover:border-stone-500 dark:border-zinc-700 dark:bg-zinc-900"
            >
              <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
              {t('Aggiorna')}
            </button>
          </div>
        </header>

        {errorMessage ? (
          <p role="alert" className="mt-4 text-sm text-red-600 dark:text-red-300">
            {errorMessage}
          </p>
        ) : null}
        {statusMessage ? (
          <output className="mt-4 block text-sm text-emerald-700 dark:text-emerald-300">
            {statusMessage}
          </output>
        ) : null}

        <nav
          aria-label={t('Sezioni amministrazione')}
          className="mt-5 grid grid-cols-3 gap-1 rounded-2xl border border-stone-200 bg-white p-1 sm:flex sm:w-fit dark:border-zinc-800 dark:bg-zinc-900"
        >
          {(
            [
              ['users', UsersRound, t('Utenti')],
              ['feedback', Flag, t('Segnalazioni')],
              ['configuration', Settings2, t('Configurazione')],
            ] as const
          ).map(([section, Icon, label]) => (
            <button
              key={section}
              type="button"
              aria-current={activeSection === section ? 'page' : undefined}
              onClick={() => setActiveSection(section)}
              className="inline-flex min-w-0 items-center justify-center gap-2 rounded-xl px-3 py-2.5 text-xs font-semibold text-stone-500 transition-colors hover:text-stone-900 aria-[current=page]:bg-stone-950 aria-[current=page]:text-stone-50 sm:min-w-36 sm:text-sm dark:text-zinc-400 dark:hover:text-zinc-100 dark:aria-[current=page]:bg-zinc-100 dark:aria-[current=page]:text-zinc-950"
            >
              <Icon className="h-4 w-4 shrink-0" />
              <span className="truncate">{label}</span>
            </button>
          ))}
        </nav>

        <section className="mt-7">
          {activeSection === 'users' ? (
            <>
              <div>
                <div className="flex flex-wrap items-end justify-between gap-4">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.16em] text-orange-600 dark:text-orange-400">
                      {t('Accessi e ruoli')}
                    </p>
                    <h2 className="mt-1 flex items-center gap-2 font-serif text-2xl">
                      <ShieldCheck className="h-5 w-5 text-stone-500 dark:text-zinc-400" />
                      {t('Utenti')}
                    </h2>
                  </div>
                  <label className="relative w-full sm:w-72">
                    <span className="sr-only">{t('Cerca utenti')}</span>
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-stone-400" />
                    <input
                      type="search"
                      value={userSearch}
                      onChange={event => setUserSearch(event.target.value)}
                      placeholder={t('Cerca in questa pagina per email o ID')}
                      className={`${adminFieldClassName} pl-9`}
                    />
                  </label>
                </div>
                <div className="mt-4 overflow-hidden rounded-2xl border border-stone-200 bg-white dark:border-zinc-700 dark:bg-zinc-900">
                  {visibleUsers.map(user => (
                    <div
                      key={user.id}
                      className="grid gap-3 border-b border-stone-100 p-4 last:border-b-0 sm:grid-cols-[1fr_auto] dark:border-zinc-800"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold">{user.email || user.id}</p>
                        <p className="mt-1 text-xs text-stone-500 dark:text-zinc-400">
                          {t(isDisabledUser(user) ? 'disabilitato' : 'attivo')}
                        </p>
                        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
                          <label className="flex items-center gap-2 text-xs text-stone-500 dark:text-zinc-400">
                            <span>{t('Ruolo')}</span>
                            <select
                              aria-label={t('Ruolo per {userName}', {
                                userName: user.email || user.id,
                              })}
                              value={getUserRole(user)}
                              onChange={event =>
                                void handleUserPatch(user, {
                                  role: event.target.value === 'admin' ? 'admin' : 'user',
                                })
                              }
                              className="rounded-lg border border-stone-300 bg-white px-2 py-1 text-xs font-medium text-stone-700 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-200"
                            >
                              <option value="user">{t('Base')}</option>
                              <option value="admin">Admin</option>
                            </select>
                          </label>
                          <label className="flex items-center gap-2 text-xs text-stone-500 dark:text-zinc-400">
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
                              className="rounded-lg border border-stone-300 bg-white px-2 py-1 text-xs text-stone-700 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-200"
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
                        <details className="mt-3 rounded-xl border border-stone-200 bg-stone-50/60 dark:border-zinc-700 dark:bg-zinc-800/30">
                          <summary className="cursor-pointer list-none px-3 py-2 text-xs font-semibold text-stone-700 dark:text-zinc-200 [&::-webkit-details-marker]:hidden">
                            {t('Backend per funzione')}
                          </summary>
                          <div className="grid gap-2 border-t border-stone-200 p-3 sm:grid-cols-2 dark:border-zinc-700">
                            {PROVIDER_OVERRIDE_ROWS.map(providerSlot =>
                              renderProviderOverrideSelect({
                                defaultProvider: getUserDefaultAiProvider(
                                  user,
                                  modelConfig,
                                  providerSlot.slot
                                ),
                                label: providerSlot.label(),
                                overrides: getUserAiProviderOverrides(user),
                                slot: providerSlot.slot,
                                onChange: aiProviderOverrides => {
                                  void handleUserPatch(user, { aiProviderOverrides });
                                },
                              })
                            )}
                          </div>
                        </details>
                      </div>
                      <div className="flex flex-wrap items-start gap-1.5 sm:justify-end">
                        <button
                          type="button"
                          aria-label={getUserAccessEmailActionLabel(user, true)}
                          disabled={magicLinkUserId !== null}
                          onClick={() => void handleMagicLinkSend(user)}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-stone-300 px-2.5 py-1.5 text-xs font-medium disabled:cursor-wait disabled:opacity-60 dark:border-zinc-600"
                        >
                          <Link2 className="h-3.5 w-3.5" />
                          {magicLinkUserId === user.id
                            ? t('Invio in corso…')
                            : getUserAccessEmailActionLabel(user)}
                        </button>
                        <button
                          type="button"
                          aria-label={t('{action} {userName}', {
                            action: t(isDisabledUser(user) ? 'Abilita' : 'Disabilita'),
                            userName: user.email || user.id,
                          })}
                          onClick={() =>
                            void handleUserPatch(user, { disabled: !isDisabledUser(user) })
                          }
                          className="rounded-lg border border-stone-300 px-2.5 py-1.5 text-xs font-medium dark:border-zinc-600"
                        >
                          {t(isDisabledUser(user) ? 'Abilita' : 'Disabilita')}
                        </button>
                        <button
                          type="button"
                          aria-label={t('Imposta password per {userName}', {
                            userName: user.email || user.id,
                          })}
                          onClick={() => {
                            setPasswordDraft('');
                            setPasswordEditorUserId(currentUserId =>
                              currentUserId === user.id ? null : user.id
                            );
                          }}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-stone-300 px-2.5 py-1.5 text-xs font-medium dark:border-zinc-600"
                        >
                          <KeyRound className="h-3.5 w-3.5" />
                          Password
                        </button>
                      </div>
                      {passwordEditorUserId === user.id ? (
                        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-stone-200 bg-stone-50 p-3 sm:col-span-2 dark:border-zinc-700 dark:bg-zinc-800/50">
                          <input
                            type="password"
                            aria-label={t('Nuova password per {userName}', {
                              userName: user.email || user.id,
                            })}
                            value={passwordDraft}
                            onChange={event => setPasswordDraft(event.target.value)}
                            className={`${adminFieldClassName} min-w-[14rem] flex-1`}
                          />
                          <button
                            type="button"
                            onClick={() => void handlePasswordSave(user)}
                            className="rounded-full bg-stone-950 px-4 py-2 text-xs font-semibold text-white dark:bg-zinc-100 dark:text-zinc-950"
                          >
                            {t('Salva password')}
                          </button>
                        </div>
                      ) : null}
                    </div>
                  ))}
                  {visibleUsers.length === 0 ? (
                    <p className="px-4 py-10 text-center text-sm text-stone-500 dark:text-zinc-400">
                      {t('Nessun utente corrisponde alla ricerca.')}
                    </p>
                  ) : null}
                  <nav
                    aria-label={t('Pagine utenti')}
                    className="flex items-center justify-between border-t border-stone-200 px-4 py-3 dark:border-zinc-700"
                  >
                    <button
                      type="button"
                      aria-label={t('Pagina precedente')}
                      disabled={isLoading || userPage <= 1}
                      onClick={() => void handleUserPageChange(userPage - 1)}
                      className="flex h-9 w-9 items-center justify-center rounded-full text-stone-500 hover:bg-stone-100 disabled:opacity-30 dark:hover:bg-zinc-800"
                    >
                      <ChevronLeft className="h-4 w-4" />
                    </button>
                    <span className="text-xs text-stone-500 dark:text-zinc-400">
                      {t('Pagina {currentPage}', { currentPage: userPage })}
                    </span>
                    <button
                      type="button"
                      aria-label={t('Pagina successiva')}
                      disabled={isLoading || !userHasMore}
                      onClick={() => void handleUserPageChange(userPage + 1)}
                      className="flex h-9 w-9 items-center justify-center rounded-full text-stone-500 hover:bg-stone-100 disabled:opacity-30 dark:hover:bg-zinc-800"
                    >
                      <ChevronRight className="h-4 w-4" />
                    </button>
                  </nav>
                </div>
              </div>

              <div className="mt-6 grid gap-4 lg:grid-cols-2">
                <form
                  onSubmit={handleAccessEmailSend}
                  className="rounded-2xl border border-stone-200 bg-white p-5 dark:border-zinc-700 dark:bg-zinc-900"
                >
                  <h2 className="text-sm font-semibold">{t('Invita o invia accesso')}</h2>
                  <p className="mt-2 text-xs leading-5 text-stone-500 dark:text-zinc-400">
                    {t(
                      'Un nuovo indirizzo riceve un link per completare l’account. Un account ancora in attesa riceve di nuovo il completamento; un account completo riceve un link di accesso.'
                    )}
                  </p>
                  <input
                    type="email"
                    aria-label={t('Email per invito o accesso')}
                    placeholder="email"
                    value={accessEmail}
                    onChange={event => setAccessEmail(event.target.value)}
                    className={`${adminFieldClassName} mt-3`}
                    required
                  />
                  <button
                    type="submit"
                    disabled={isSendingAccessEmail}
                    aria-busy={isSendingAccessEmail}
                    className="mt-3 inline-flex items-center justify-center gap-2 rounded-full bg-stone-950 px-4 py-2.5 text-sm font-semibold text-white disabled:cursor-wait disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-950"
                  >
                    <Link2 className="h-4 w-4" />
                    {t(isSendingAccessEmail ? 'Invio in corso…' : 'Invia email')}
                  </button>
                </form>

                <form
                  onSubmit={handleCreateUser}
                  className="rounded-2xl border border-stone-200 bg-white p-5 dark:border-zinc-700 dark:bg-zinc-900"
                >
                  <h2 className="text-sm font-semibold">{t('Crea account')}</h2>
                  <input
                    type="email"
                    aria-label={t('Email nuovo account')}
                    placeholder="email"
                    value={email}
                    onChange={event => setEmail(event.target.value)}
                    className={`${adminFieldClassName} mt-3`}
                    required
                  />
                  <input
                    type="password"
                    aria-label={t('Password nuovo account')}
                    placeholder="password"
                    value={password}
                    onChange={event => setPassword(event.target.value)}
                    className={`${adminFieldClassName} mt-2`}
                    required
                  />
                  <select
                    aria-label={t('Ruolo nuovo account')}
                    value={role}
                    onChange={event => setRole(event.target.value === 'admin' ? 'admin' : 'user')}
                    className={`${adminFieldClassName} mt-2`}
                  >
                    <option value="user">{t('Base')}</option>
                    <option value="admin">Admin</option>
                  </select>
                  <select
                    aria-label={t('Provider AI nuovo account')}
                    value={newUserAiProvider}
                    onChange={event => setNewUserAiProvider(readUserAiProvider(event.target.value))}
                    className={`${adminFieldClassName} mt-2`}
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
                    className="mt-3 inline-flex items-center justify-center gap-2 rounded-full bg-stone-950 px-4 py-2.5 text-sm font-semibold text-white dark:bg-zinc-100 dark:text-zinc-950"
                  >
                    <Plus className="h-4 w-4" />
                    {t('Crea')}
                  </button>
                </form>
              </div>
            </>
          ) : null}

          {activeSection === 'feedback' ? <AdminFeedbackPanel /> : null}

          {activeSection === 'configuration' ? (
            <section aria-labelledby="admin-configuration-title">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-orange-600 dark:text-orange-400">
                  {t('Motore di Nous')}
                </p>
                <h2 id="admin-configuration-title" className="mt-1 font-serif text-2xl">
                  {t('Configurazione')}
                </h2>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-stone-500 dark:text-zinc-400">
                  {t(
                    'Apri solo il provider che devi modificare. Le impostazioni restano separate e leggibili.'
                  )}
                </p>
              </div>

              <CourseCoverRegenerationControl />

              <div className="mt-5 overflow-hidden rounded-2xl border border-stone-200 bg-white dark:border-zinc-700 dark:bg-zinc-900">
                <fieldset disabled={!isModelConfigLoaded} aria-busy={!isModelConfigLoaded}>
                  <AdminDisclosure
                    defaultOpen
                    icon={Settings2}
                    title={t('Modelli globali')}
                    status={
                      AI_PROVIDER_OPTIONS.find(([id]) => id === modelConfig.aiProvider)?.[1] ||
                      modelConfig.aiProvider
                    }
                  >
                    <label className="mt-4 block">
                      <span className="flex items-center gap-2 text-sm font-semibold text-stone-800 dark:text-zinc-200">
                        <Link2 className="h-4 w-4 text-stone-500 dark:text-zinc-400" />
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
                        className={`${adminFieldClassName} mt-1`}
                      >
                        {AI_PROVIDER_OPTIONS.map(([value, label]) => (
                          <option key={value} value={value}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <div className="mt-4">
                      <p className="text-sm font-semibold text-stone-800 dark:text-zinc-200">
                        {t('Backend per funzione')}
                      </p>
                      <p className="mt-1 text-xs leading-5 text-stone-500 dark:text-zinc-400">
                        {t(
                          'Ogni funzione eredita il provider globale, salvo gli override indicati qui.'
                        )}
                      </p>
                      <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                        {PROVIDER_OVERRIDE_ROWS.map(providerSlot =>
                          renderProviderOverrideSelect({
                            defaultProvider: modelConfig.aiProvider,
                            label: providerSlot.label(),
                            overrides: modelConfig.aiProviderOverrides,
                            slot: providerSlot.slot,
                            onChange: aiProviderOverrides =>
                              setModelConfig(current => ({
                                ...current,
                                aiProviderOverrides,
                              })),
                          })
                        )}
                      </div>
                    </div>
                    <label className="mt-4 flex items-start gap-3 rounded-xl border border-stone-200 px-3 py-3 dark:border-zinc-700">
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
                        className="mt-0.5 h-4 w-4 rounded border-stone-300"
                      />
                      <span>
                        <span className="block text-sm font-semibold text-stone-800 dark:text-zinc-200">
                          {t('Revisione visiva degli artefatti')}
                        </span>
                        <span className="mt-1 block text-xs leading-5 text-stone-500 dark:text-zinc-400">
                          {t(
                            'Aggiunge un secondo passaggio di controllo dopo la prima generazione.'
                          )}
                        </span>
                      </span>
                    </label>
                    <label className="mt-3 block">
                      <span className="text-sm font-semibold text-stone-800 dark:text-zinc-200">
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
                        className={`${adminFieldClassName} mt-1 w-24 disabled:bg-stone-100 disabled:text-stone-400 dark:disabled:bg-zinc-800`}
                      />
                    </label>
                  </AdminDisclosure>
                  {PROVIDER_SECTIONS.map(({ id, label }) => (
                    <AdminDisclosure
                      key={id}
                      icon={
                        id === 'openrouter' ? Link2 : id === 'openai' ? BrainCircuit : Settings2
                      }
                      title={label}
                      status={
                        modelConfig.aiProvider === id ? t('Provider attivo') : t('Configurato')
                      }
                    >
                      {id === 'codex' ? (
                        <div className="mb-5 [&>section]:border-0 [&>section]:bg-transparent [&>section]:p-0">
                          <CodexConnectionSettings />
                        </div>
                      ) : null}
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
                      {id === 'openai'
                        ? renderSingleModelRow({
                            icon: Image,
                            label: t('Immagini'),
                            modelKey: 'openAiImageModel',
                          })
                        : null}
                    </AdminDisclosure>
                  ))}
                  <p className="border-t border-stone-200 px-5 pt-4 text-xs leading-5 text-stone-500 dark:border-zinc-700 dark:text-zinc-400">
                    {t(
                      'La forza di ragionamento è condivisa per funzione; i modelli restano separati per provider. TTS e immagini non usano reasoning.'
                    )}
                  </p>
                  <button
                    type="button"
                    onClick={() => void handleModelSave()}
                    disabled={isSavingModels || !isModelConfigLoaded}
                    aria-busy={isSavingModels}
                    className="m-5 inline-flex items-center justify-center gap-2 rounded-full bg-stone-950 px-5 py-2.5 text-sm font-semibold text-white disabled:cursor-wait disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-950"
                  >
                    <Save className="h-4 w-4" />
                    {t('Salva modelli')}
                  </button>
                </fieldset>
              </div>
            </section>
          ) : null}
        </section>
      </div>
    </main>
  );
}
