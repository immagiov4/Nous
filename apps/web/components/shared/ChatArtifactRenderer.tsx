import {
  AlertTriangle,
  Check,
  Download,
  FileImage,
  MousePointerClick,
  Network,
  RefreshCw,
  Trash2,
  X,
} from 'lucide-react';
import { type Dispatch, memo, type SetStateAction, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';

import { translateUiMessage as t } from '../../i18n/uiMessages.ts';
import type { LearningArtifactRenderPayload } from '../../types.ts';
import GeneratedVisualFrame from './GeneratedVisualFrame.tsx';

export interface ChatArtifactActionRequest {
  artifactId: string;
}

export interface ChatArtifactRegenerateRequest extends ChatArtifactActionRequest {
  instructions: string;
}

export interface ChatArtifactReplaceRequest extends ChatArtifactActionRequest {
  replacementOfArtifactId: string;
}

export type ChatArtifactRegenerationStates = Record<string, 'working' | 'succeeded' | 'failed'>;

export interface ChatArtifactRegenerationLifecycle {
  replacementSourceArtifactIds: ReadonlySet<string>;
  setStates: Dispatch<SetStateAction<ChatArtifactRegenerationStates>>;
  states: ChatArtifactRegenerationStates;
}

interface ChatArtifactRendererProps {
  readonly actionFeedbackOverride?: ArtifactActionFeedback;
  readonly artifacts: LearningArtifactRenderPayload[];
  readonly className?: string;
  readonly isDarkMode: boolean;
  /** Called when user clicks "Salva" in the overlay footer. Returns a promise so the button shows saving state correctly. */
  readonly onSaveArtifact?: (request: ChatArtifactActionRequest) => Promise<void>;
  /** Called when user clicks "Rigenera" in the overlay footer. */
  readonly onRegenerateArtifact?: (
    request: ChatArtifactRegenerateRequest
  ) => Promise<boolean> | boolean;
  /** Called when user clicks "Scarta" in the overlay footer. */
  readonly onDiscardArtifact?: (request: ChatArtifactActionRequest) => Promise<void> | void;
  /** Called when user approves a replacement draft. */
  readonly onReplaceArtifact?: (request: ChatArtifactReplaceRequest) => Promise<void> | void;
  /** If true, the artifact grid shows a loading skeleton instead of cards. */
  readonly isLoading?: boolean;
  readonly openArtifactIdOverride?: string | null;
  readonly portalContainer?: HTMLElement | null;
  readonly regenerationLifecycle?: ChatArtifactRegenerationLifecycle;
  /** When set, replaces the Maximize2 icon with an X remove button inside the card. */
  readonly onRemoveArtifact?: (artifactId: string) => void;
}

const getArtifactKindLabel = (artifact: LearningArtifactRenderPayload): string => {
  if (artifact.summary.kind === 'pdf-image') {
    return t('Immagine PDF');
  }

  if ('visual' in artifact && artifact.visual.kind === 'image') {
    return t('Immagine generata');
  }

  if ('visual' in artifact && artifact.visual.kind === 'html') {
    return t('Interattivo');
  }

  return t('Visuale');
};

const getArtifactIcon = (artifact: LearningArtifactRenderPayload) => {
  if (
    artifact.summary.kind === 'pdf-image' ||
    ('visual' in artifact && artifact.visual.kind === 'image')
  ) {
    return FileImage;
  }

  if ('visual' in artifact && artifact.visual.kind === 'html') {
    return MousePointerClick;
  }

  return Network;
};

const getArtifactReplacementTargetId = (artifact: LearningArtifactRenderPayload) =>
  artifact.summary.kind === 'generated-visual'
    ? artifact.summary.replacementOfArtifactId
    : undefined;

const ARTIFACT_ACTION_FEEDBACK = {
  actionFailed: () => t('Operazione non riuscita. L artefatto non e stato modificato.'),
  discarded: () => t('Artefatto scartato.'),
  regenerationFailed: () => t('Rigenerazione fallita. La bozza precedente non e stata modificata.'),
  regenerationRequested: () => t('Rigenerazione richiesta.'),
  replaced: () => t('Artefatto sostituito.'),
  saved: () => t('Salvato.'),
} as const satisfies Record<string, () => string>;

type ArtifactActionFeedback = keyof typeof ARTIFACT_ACTION_FEEDBACK;

const ArtifactPreview = ({
  artifact,
  isDarkMode,
}: {
  artifact: LearningArtifactRenderPayload;
  isDarkMode: boolean;
}) => {
  if (artifact.summary.previewMode !== 'thumbnail') {
    return null;
  }

  if ('image' in artifact) {
    return (
      <img
        src={artifact.image.dataUrl}
        alt={artifact.summary.title}
        className="h-12 w-full rounded-xl border border-stone-200/80 bg-stone-50 object-cover dark:border-zinc-700 dark:bg-zinc-900"
      />
    );
  }

  if ('visual' in artifact) {
    return (
      <div className="pointer-events-none h-16 overflow-hidden rounded-xl border border-stone-200/80 bg-white/70 dark:border-zinc-700 dark:bg-zinc-900/60">
        <GeneratedVisualFrame
          isDarkMode={isDarkMode}
          title={artifact.summary.title}
          visual={artifact.visual}
        />
      </div>
    );
  }

  return null;
};

const ArtifactOverlay = ({
  actionFeedbackOverride,
  artifact,
  isDarkMode,
  onClose,
  onDiscardArtifact,
  onRegenerateArtifact,
  onReplaceArtifact,
  onSaveArtifact,
}: {
  actionFeedbackOverride?: ArtifactActionFeedback;
  artifact: LearningArtifactRenderPayload;
  isDarkMode: boolean;
  onClose: () => void;
  onDiscardArtifact?: (request: ChatArtifactActionRequest) => Promise<void> | void;
  onRegenerateArtifact?: (request: ChatArtifactRegenerateRequest) => Promise<boolean> | boolean;
  onReplaceArtifact?: (request: ChatArtifactReplaceRequest) => Promise<void> | void;
  onSaveArtifact?: (request: ChatArtifactActionRequest) => Promise<void>;
}) => {
  const [isSaving, setIsSaving] = useState(false);
  const [isRegenerating, setIsRegenerating] = useState(false);
  const [isRegenerationFormOpen, setIsRegenerationFormOpen] = useState(false);
  const [regenerationInstructions, setRegenerationInstructions] = useState('');
  const [actionFeedback, setActionFeedback] = useState<ArtifactActionFeedback | null>(null);
  const replacementOfArtifactId = getArtifactReplacementTargetId(artifact);
  const canRegenerate =
    Boolean(onRegenerateArtifact) && artifact.summary.kind === 'generated-visual';
  const canReplace = Boolean(onReplaceArtifact && replacementOfArtifactId);
  const shouldShowSaveAction = Boolean(onSaveArtifact && !canReplace);
  const hasActions = shouldShowSaveAction || canRegenerate || onDiscardArtifact || canReplace;
  const trimmedRegenerationInstructions = regenerationInstructions.trim();
  const visibleActionFeedback = actionFeedbackOverride ?? actionFeedback;
  const hasFailedAction =
    visibleActionFeedback === 'actionFailed' || visibleActionFeedback === 'regenerationFailed';

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    globalThis.window.addEventListener('keydown', handleKeyDown);
    return () => globalThis.window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const handleDiscardArtifact = async () => {
    setActionFeedback(null);
    try {
      await onDiscardArtifact?.({ artifactId: artifact.summary.id });
      setActionFeedback('discarded');
    } catch (error) {
      console.error('[Nous][Artifact] Discard failed.', error);
      setActionFeedback('actionFailed');
    }
  };

  const handleRegenerateArtifact = async () => {
    if (!onRegenerateArtifact || !trimmedRegenerationInstructions || isRegenerating) {
      return;
    }

    setIsRegenerating(true);
    setActionFeedback(null);
    try {
      const regenerated = await onRegenerateArtifact({
        artifactId: artifact.summary.id,
        instructions: trimmedRegenerationInstructions,
      });
      setActionFeedback(regenerated ? 'regenerationRequested' : 'regenerationFailed');
      if (regenerated) {
        setIsRegenerationFormOpen(false);
        setRegenerationInstructions('');
      }
    } finally {
      setIsRegenerating(false);
    }
  };

  const handleReplaceArtifact = async () => {
    if (!onReplaceArtifact || !replacementOfArtifactId) {
      return;
    }

    setActionFeedback(null);
    try {
      await onReplaceArtifact({
        artifactId: artifact.summary.id,
        replacementOfArtifactId,
      });
      setActionFeedback('replaced');
    } catch (error) {
      console.error('[Nous][Artifact] Replacement failed.', error);
      setActionFeedback('actionFailed');
    }
  };

  const handleSaveArtifact = async () => {
    if (!onSaveArtifact) {
      return;
    }

    setIsSaving(true);
    setActionFeedback(null);
    try {
      await onSaveArtifact({ artifactId: artifact.summary.id });
      setActionFeedback('saved');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div
      role="presentation"
      className="fixed inset-0 z-[130] flex items-center justify-center bg-black/60 p-3 sm:p-6"
    >
      <button
        type="button"
        aria-label={t('Chiudi anteprima artefatto')}
        onClick={onClose}
        className="absolute inset-0 cursor-default"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={artifact.summary.title}
        className="relative flex max-h-[92dvh] w-full max-w-5xl flex-col overflow-hidden rounded-[1.6rem] border border-white/20 bg-white shadow-2xl dark:border-zinc-700 dark:bg-zinc-900"
      >
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-stone-200/80 px-4 py-3 dark:border-zinc-700 sm:px-5">
          <div className="min-w-0">
            <p className="text-xs font-semibold text-orange-700 dark:text-orange-300">
              {getArtifactKindLabel(artifact)}
            </p>
            <h3 className="mt-1 truncate text-sm font-semibold text-stone-900 dark:text-zinc-100 sm:text-base">
              {artifact.summary.title}
            </h3>
          </div>
          <button
            type="button"
            data-artifact-target="close"
            onClick={onClose}
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-stone-400 transition-colors hover:bg-stone-100 hover:text-stone-700 dark:text-zinc-500 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
            aria-label={t('Chiudi artefatto')}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto bg-transparent p-4 sm:p-6">
          {'image' in artifact ? (
            <img
              src={artifact.image.dataUrl}
              alt={artifact.summary.title}
              className="mx-auto block max-h-[72dvh] max-w-full rounded-xl object-contain"
            />
          ) : 'visual' in artifact ? (
            <div className="mx-auto max-w-4xl">
              <GeneratedVisualFrame
                className="my-0"
                isDarkMode={isDarkMode}
                title={artifact.summary.title}
                visual={artifact.visual}
              />
            </div>
          ) : null}
        </div>

        {hasActions ? (
          <div className="shrink-0 space-y-3 border-t border-stone-200/80 px-4 py-3 dark:border-zinc-700 sm:px-5">
            {isRegenerationFormOpen ? (
              <div className="rounded-2xl border border-stone-200/80 bg-stone-50/80 p-3 dark:border-zinc-700 dark:bg-zinc-800/70">
                <label className="block text-xs font-semibold text-stone-600 dark:text-zinc-300">
                  {t('Istruzioni rigenerazione')}
                  <textarea
                    value={regenerationInstructions}
                    onChange={event => {
                      setRegenerationInstructions(event.target.value);
                      setActionFeedback(null);
                    }}
                    rows={3}
                    className="mt-2 w-full resize-none rounded-xl border border-stone-200 bg-white px-3 py-2 text-sm leading-5 text-stone-800 outline-none transition-colors placeholder:text-stone-400 focus:border-stone-300 focus:ring-0 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:placeholder:text-zinc-500"
                    placeholder={t('Spiega cosa cambiare nella nuova bozza...')}
                  />
                </label>
                <div className="mt-2 flex justify-end">
                  <button
                    type="button"
                    onClick={() => void handleRegenerateArtifact()}
                    disabled={!trimmedRegenerationInstructions || isRegenerating}
                    className="inline-flex items-center gap-1.5 rounded-full bg-stone-900 px-4 py-2 text-xs font-semibold text-stone-50 transition-colors hover:bg-stone-700 disabled:bg-stone-200 disabled:text-stone-500 dark:bg-stone-100 dark:text-stone-900 dark:hover:bg-white dark:disabled:bg-zinc-700 dark:disabled:text-zinc-400"
                    aria-label={t('Conferma rigenerazione')}
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                    <span>{isRegenerating ? t('Rigenerazione...') : t('Rigenera bozza')}</span>
                  </button>
                </div>
              </div>
            ) : null}

            <div className="flex flex-wrap items-center justify-between gap-2">
              {visibleActionFeedback ? (
                <div
                  className={`inline-flex items-center gap-2 rounded-full px-3 py-2 text-xs font-semibold ${
                    hasFailedAction
                      ? 'bg-red-50 text-red-700 dark:bg-red-950/30 dark:text-red-200'
                      : 'bg-stone-100 text-stone-600 dark:bg-zinc-800 dark:text-zinc-200'
                  }`}
                >
                  {hasFailedAction ? (
                    <AlertTriangle className="h-3.5 w-3.5" />
                  ) : (
                    <Check className="h-3.5 w-3.5" />
                  )}
                  <span>{ARTIFACT_ACTION_FEEDBACK[visibleActionFeedback]()}</span>
                </div>
              ) : (
                <span />
              )}

              <div className="flex flex-wrap items-center justify-end gap-2">
                {onDiscardArtifact ? (
                  <button
                    type="button"
                    onClick={() => void handleDiscardArtifact()}
                    className="inline-flex items-center gap-1.5 rounded-full px-3 py-2 text-xs font-semibold text-stone-500 transition-colors hover:bg-stone-100 hover:text-red-600 dark:text-stone-400 dark:hover:bg-zinc-800 dark:hover:text-red-400"
                    aria-label={t('Scarta artefatto')}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    <span>{t('Scarta')}</span>
                  </button>
                ) : null}
                {canRegenerate ? (
                  <button
                    type="button"
                    onClick={() => setIsRegenerationFormOpen(currentValue => !currentValue)}
                    className="inline-flex items-center gap-1.5 rounded-full px-3 py-2 text-xs font-semibold text-stone-500 transition-colors hover:bg-stone-100 hover:text-amber-600 dark:text-stone-400 dark:hover:bg-zinc-800 dark:hover:text-amber-400"
                    aria-label={t('Rigenera artefatto')}
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                    <span>{t('Rigenera')}</span>
                  </button>
                ) : null}
                {canReplace ? (
                  <button
                    type="button"
                    onClick={() => void handleReplaceArtifact()}
                    className="inline-flex items-center gap-1.5 rounded-full bg-stone-900 px-4 py-2 text-xs font-semibold text-stone-50 transition-colors hover:bg-stone-700 disabled:opacity-60 dark:bg-stone-100 dark:text-stone-900 dark:hover:bg-white"
                    aria-label={t('Sostituisci artefatto')}
                  >
                    <Check className="h-3.5 w-3.5" />
                    <span>{t('Sostituisci')}</span>
                  </button>
                ) : null}
                {shouldShowSaveAction ? (
                  <button
                    type="button"
                    data-artifact-target="save"
                    onClick={() => void handleSaveArtifact()}
                    disabled={isSaving}
                    className="inline-flex items-center gap-1.5 rounded-full bg-stone-900 px-4 py-2 text-xs font-semibold text-stone-50 transition-colors hover:bg-stone-700 disabled:opacity-60 dark:bg-stone-100 dark:text-stone-900 dark:hover:bg-white"
                    aria-label={t('Salva artefatto nella lezione')}
                  >
                    <Download className="h-3.5 w-3.5" />
                    <span>{isSaving ? t('Salvando...') : t('Salva')}</span>
                  </button>
                ) : null}
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
};

const ChatArtifactRenderer = ({
  actionFeedbackOverride,
  artifacts,
  className = 'mt-3 grid gap-2 sm:grid-cols-2',
  isDarkMode,
  isLoading = false,
  openArtifactIdOverride,
  portalContainer,
  regenerationLifecycle,
  onDiscardArtifact,
  onRegenerateArtifact,
  onRemoveArtifact,
  onReplaceArtifact,
  onSaveArtifact,
}: ChatArtifactRendererProps) => {
  const [openArtifactId, setOpenArtifactId] = useState<string | null>(null);
  const [localRegenerationStates, setLocalRegenerationStates] =
    useState<ChatArtifactRegenerationStates>({});
  const regenerationStates = regenerationLifecycle?.states ?? localRegenerationStates;
  const setRegenerationStates = regenerationLifecycle?.setStates ?? setLocalRegenerationStates;

  // Deduplicate by artifact summary ID to avoid React key warnings.
  const deduplicatedArtifacts = useMemo(
    () =>
      artifacts.reduce<LearningArtifactRenderPayload[]>((acc, artifact) => {
        if (!acc.some(existing => existing.summary.id === artifact.summary.id)) {
          acc.push(artifact);
        }
        return acc;
      }, []),
    [artifacts]
  );
  const currentArtifacts = useMemo(() => {
    const replacementsByTarget = new Map<string, LearningArtifactRenderPayload[]>();
    for (const artifact of deduplicatedArtifacts) {
      const replacementTargetId = getArtifactReplacementTargetId(artifact);
      if (replacementTargetId) {
        const replacements = replacementsByTarget.get(replacementTargetId) || [];
        replacements.push(artifact);
        replacementsByTarget.set(replacementTargetId, replacements);
      }
    }

    const activeReplacementIds = new Set<string>();
    const replacedArtifactIds = new Set<string>();
    for (const [replacementTargetId, replacements] of replacementsByTarget) {
      const latestCreatedAt = replacements.reduce(
        (latest, artifact) =>
          'visual' in artifact && artifact.visual.createdAt > latest
            ? artifact.visual.createdAt
            : latest,
        ''
      );
      const latestReplacements = replacements.filter(
        artifact => 'visual' in artifact && artifact.visual.createdAt === latestCreatedAt
      );
      if (latestReplacements.length === 1) {
        activeReplacementIds.add(latestReplacements[0].summary.id);
        replacedArtifactIds.add(replacementTargetId);
      }
    }

    return deduplicatedArtifacts.filter(artifact => {
      const replacementTargetId = getArtifactReplacementTargetId(artifact);
      const isActiveReplacement =
        !replacementTargetId || activeReplacementIds.has(artifact.summary.id);
      return isActiveReplacement && !replacedArtifactIds.has(artifact.summary.id);
    });
  }, [deduplicatedArtifacts]);
  const observedReplacementTargetIds = useMemo(() => {
    const replacementTargetIds = new Set(regenerationLifecycle?.replacementSourceArtifactIds);
    for (const artifact of deduplicatedArtifacts) {
      const replacementTargetId = getArtifactReplacementTargetId(artifact);
      if (replacementTargetId) {
        replacementTargetIds.add(replacementTargetId);
      }
    }
    return replacementTargetIds;
  }, [deduplicatedArtifacts, regenerationLifecycle?.replacementSourceArtifactIds]);
  const renderedArtifactIds = useMemo(
    () => new Set(deduplicatedArtifacts.map(artifact => artifact.summary.id)),
    [deduplicatedArtifacts]
  );
  const visibleRegenerationStates = Object.entries(regenerationStates).filter(
    ([sourceArtifactId, state]) =>
      renderedArtifactIds.has(sourceArtifactId) &&
      (state !== 'succeeded' || !observedReplacementTargetIds.has(sourceArtifactId))
  );
  const visibleArtifacts = currentArtifacts.filter(artifact => {
    const regenerationState = regenerationStates[artifact.summary.id];
    return regenerationState !== 'working' && regenerationState !== 'succeeded';
  });

  const clearSucceededRegenerationState = (sourceArtifactId: string | undefined) => {
    if (!sourceArtifactId) {
      return;
    }

    setRegenerationStates(currentStates => {
      if (currentStates[sourceArtifactId] !== 'succeeded') {
        return currentStates;
      }

      const nextStates = { ...currentStates };
      delete nextStates[sourceArtifactId];
      return nextStates;
    });
  };
  const clearReplacementSourceRegenerationState = (artifactId: string) => {
    const artifact = deduplicatedArtifacts.find(candidate => candidate.summary.id === artifactId);
    clearSucceededRegenerationState(
      artifact ? getArtifactReplacementTargetId(artifact) : undefined
    );
  };

  const resolvedOpenArtifactId =
    openArtifactIdOverride === undefined ? openArtifactId : openArtifactIdOverride;
  const openArtifact =
    visibleArtifacts.find(artifact => artifact.summary.id === resolvedOpenArtifactId) || null;
  const handleRegenerateFromOverlay = onRegenerateArtifact
    ? async (request: ChatArtifactRegenerateRequest): Promise<boolean> => {
        setOpenArtifactId(null);
        setRegenerationStates(currentStates => ({
          ...currentStates,
          [request.artifactId]: 'working',
        }));
        try {
          const regenerated = await onRegenerateArtifact(request);
          setRegenerationStates(currentStates => ({
            ...currentStates,
            [request.artifactId]: regenerated ? 'succeeded' : 'failed',
          }));
          return regenerated;
        } catch (error) {
          setRegenerationStates(currentStates => ({
            ...currentStates,
            [request.artifactId]: 'failed',
          }));
          throw error;
        }
      }
    : undefined;
  const handleDiscardFromOverlay = onDiscardArtifact
    ? async (request: ChatArtifactActionRequest) => {
        await onDiscardArtifact(request);
        clearReplacementSourceRegenerationState(request.artifactId);
      }
    : undefined;
  const handleReplaceFromOverlay = onReplaceArtifact
    ? async (request: ChatArtifactReplaceRequest) => {
        await onReplaceArtifact(request);
        clearSucceededRegenerationState(request.replacementOfArtifactId);
      }
    : undefined;
  const handleRemoveArtifact = onRemoveArtifact
    ? (artifactId: string) => {
        clearReplacementSourceRegenerationState(artifactId);
        onRemoveArtifact(artifactId);
      }
    : undefined;
  const artifactOverlay = openArtifact ? (
    <ArtifactOverlay
      key={openArtifact.summary.id}
      actionFeedbackOverride={actionFeedbackOverride}
      artifact={openArtifact}
      isDarkMode={isDarkMode}
      onClose={() => setOpenArtifactId(null)}
      onDiscardArtifact={handleDiscardFromOverlay}
      onRegenerateArtifact={handleRegenerateFromOverlay}
      onReplaceArtifact={handleReplaceFromOverlay}
      onSaveArtifact={onSaveArtifact}
    />
  ) : null;

  if (artifacts.length === 0 && !isLoading) {
    return null;
  }

  return (
    <div className={className}>
      {visibleRegenerationStates.map(([sourceArtifactId, regenerationState]) => (
        <output
          key={sourceArtifactId}
          className={`col-span-full flex items-center gap-2 rounded-2xl border p-4 text-sm ${
            regenerationState === 'failed'
              ? 'border-red-200 bg-red-50 text-red-700 dark:border-red-900/60 dark:bg-red-950/30 dark:text-red-300'
              : 'border-stone-200/90 bg-white/85 text-stone-600 dark:border-zinc-700/80 dark:bg-stone-800/75 dark:text-zinc-300'
          }`}
        >
          {regenerationState === 'working' ? (
            <RefreshCw className="h-4 w-4 animate-spin" />
          ) : regenerationState === 'failed' ? (
            <AlertTriangle className="h-4 w-4" />
          ) : (
            <Check className="h-4 w-4" />
          )}
          <span>
            {regenerationState === 'working'
              ? t('Richiesta ricevuta. Sto rigenerando l artefatto...')
              : regenerationState === 'failed'
                ? ARTIFACT_ACTION_FEEDBACK.regenerationFailed()
                : t('Nuova bozza pronta.')}
          </span>
        </output>
      ))}
      {isLoading ? (
        <div className="col-span-full flex items-center gap-2 rounded-2xl border border-stone-200/90 bg-white/85 p-4 text-sm text-stone-500 dark:border-zinc-700/80 dark:bg-stone-800/75 dark:text-zinc-400">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-orange-500 border-t-transparent" />
          <span>{t('Generazione artefatto in corso...')}</span>
        </div>
      ) : (
        visibleArtifacts.map(artifact => {
          const Icon = getArtifactIcon(artifact);
          const hasPreview = artifact.summary.previewMode === 'thumbnail';
          return (
            <div
              key={artifact.summary.id}
              className="group relative min-w-0 rounded-2xl border border-stone-200/90 bg-white/85 p-2.5 shadow-sm transition-colors hover:border-orange-200 hover:bg-orange-50/45 dark:border-zinc-700/80 dark:bg-stone-800/75 dark:hover:border-orange-500/40 dark:hover:bg-orange-500/10"
            >
              <button
                type="button"
                data-artifact-target={`open-${artifact.summary.id}`}
                onClick={() => setOpenArtifactId(artifact.summary.id)}
                className="block w-full min-w-0 text-left"
                aria-label={t('Apri {artifactTitle}', {
                  artifactTitle: artifact.summary.title,
                })}
              >
                <ArtifactPreview artifact={artifact} isDarkMode={isDarkMode} />
                <span
                  className={`${hasPreview ? 'mt-2' : ''} flex min-w-0 items-start gap-2 ${
                    handleRemoveArtifact ? 'pr-7' : ''
                  }`}
                >
                  <span className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-orange-50 text-orange-700 dark:bg-orange-500/15 dark:text-orange-200">
                    <Icon className="h-3.5 w-3.5" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-stone-900 dark:text-zinc-100">
                      {artifact.summary.title}
                    </span>
                    <span className="mt-0.5 block truncate text-xs text-stone-500 dark:text-zinc-400">
                      {artifact.summary.lessonTitle} · {getArtifactKindLabel(artifact)}
                    </span>
                  </span>
                </span>
              </button>
              {handleRemoveArtifact ? (
                <button
                  type="button"
                  onClick={() => handleRemoveArtifact(artifact.summary.id)}
                  className="absolute right-2.5 bottom-2.5 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-lg text-stone-400 transition-colors hover:bg-red-50 hover:text-red-600 dark:text-zinc-500 dark:hover:bg-stone-700 dark:hover:text-red-300"
                  aria-label={t('Rimuovi {artifactTitle} dalla nota', {
                    artifactTitle: artifact.summary.title,
                  })}
                  title={t('Rimuovi dalla nota')}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              ) : null}
            </div>
          );
        })
      )}

      {artifactOverlay && typeof document !== 'undefined'
        ? createPortal(artifactOverlay, portalContainer ?? document.body)
        : artifactOverlay}
    </div>
  );
};

export default memo(ChatArtifactRenderer);
