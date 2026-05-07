import {
  Download,
  FileImage,
  MousePointerClick,
  Network,
  RefreshCw,
  Trash2,
  X,
} from 'lucide-react';
import { memo, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';

import type { LearningArtifactRenderPayload } from '../../types.ts';
import GeneratedVisualFrame from './GeneratedVisualFrame.tsx';

interface ChatArtifactRendererProps {
  artifacts: LearningArtifactRenderPayload[];
  className?: string;
  isDarkMode: boolean;
  /** Called when user clicks "Salva" in the overlay footer. Returns a promise so the button shows saving state correctly. */
  onSaveArtifact?: (artifactId: string) => Promise<void>;
  /** Called when user clicks "Rigenera" in the overlay footer. */
  onRegenerateArtifact?: (artifactId: string) => void;
  /** Called when user clicks "Scarta" in the overlay footer. */
  onDiscardArtifact?: (artifactId: string) => void;
  /** If true, the artifact grid shows a loading skeleton instead of cards. */
  isLoading?: boolean;
  /** When set, replaces the Maximize2 icon with an X remove button inside the card. */
  onRemoveArtifact?: (artifactId: string) => void;
}

const getArtifactKindLabel = (artifact: LearningArtifactRenderPayload): string => {
  if (artifact.summary.kind === 'pdf-image') {
    return 'Immagine PDF';
  }

  if ('visual' in artifact && artifact.visual.kind === 'html') {
    return 'Interattivo';
  }

  return 'Visuale';
};

const getArtifactIcon = (artifact: LearningArtifactRenderPayload) => {
  if (artifact.summary.kind === 'pdf-image') {
    return FileImage;
  }

  if ('visual' in artifact && artifact.visual.kind === 'html') {
    return MousePointerClick;
  }

  return Network;
};

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
        className="h-24 w-full rounded-xl border border-stone-200/80 bg-stone-50 object-cover dark:border-zinc-700 dark:bg-zinc-900"
      />
    );
  }

  if ('visual' in artifact) {
    return (
      <div className="pointer-events-none max-h-32 overflow-hidden rounded-xl border border-stone-200/80 bg-white/70 dark:border-zinc-700 dark:bg-zinc-900/60">
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
  artifact,
  isDarkMode,
  onClose,
  onDiscardArtifact,
  onRegenerateArtifact,
  onSaveArtifact,
}: {
  artifact: LearningArtifactRenderPayload;
  isDarkMode: boolean;
  onClose: () => void;
  onDiscardArtifact?: (artifactId: string) => void;
  onRegenerateArtifact?: (artifactId: string) => void;
  onSaveArtifact?: (artifactId: string) => Promise<void>;
}) => {
  const [isSaving, setIsSaving] = useState(false);
  const hasActions = onSaveArtifact || onRegenerateArtifact || onDiscardArtifact;

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <div
      role="presentation"
      onClick={onClose}
      className="fixed inset-0 z-[130] flex items-center justify-center bg-black/60 p-3 sm:p-6"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={artifact.summary.title}
        onClick={event => event.stopPropagation()}
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
            onClick={onClose}
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-stone-400 transition-colors hover:bg-stone-100 hover:text-stone-700 dark:text-zinc-500 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
            aria-label="Chiudi artefatto"
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
          <div className="flex shrink-0 items-center justify-end gap-2 border-t border-stone-200/80 px-4 py-3 dark:border-zinc-700 sm:px-5">
            {onDiscardArtifact ? (
              <button
                type="button"
                onClick={() => onDiscardArtifact(artifact.summary.id)}
                className="inline-flex items-center gap-1.5 rounded-full px-3 py-2 text-xs font-semibold text-stone-500 transition-colors hover:bg-stone-100 hover:text-red-600 dark:text-stone-400 dark:hover:bg-zinc-800 dark:hover:text-red-400"
                aria-label="Scarta artefatto"
              >
                <Trash2 className="h-3.5 w-3.5" />
                <span>Scarta</span>
              </button>
            ) : null}
            {onRegenerateArtifact ? (
              <button
                type="button"
                onClick={() => onRegenerateArtifact(artifact.summary.id)}
                className="inline-flex items-center gap-1.5 rounded-full px-3 py-2 text-xs font-semibold text-stone-500 transition-colors hover:bg-stone-100 hover:text-amber-600 dark:text-stone-400 dark:hover:bg-zinc-800 dark:hover:text-amber-400"
                aria-label="Rigenera artefatto"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                <span>Rigenera</span>
              </button>
            ) : null}
            {onSaveArtifact ? (
              <button
                type="button"
                onClick={async () => {
                  setIsSaving(true);
                  try {
                    await onSaveArtifact(artifact.summary.id);
                  } finally {
                    setIsSaving(false);
                    onClose();
                  }
                }}
                disabled={isSaving}
                className="inline-flex items-center gap-1.5 rounded-full bg-stone-900 px-4 py-2 text-xs font-semibold text-stone-50 transition-colors hover:bg-stone-700 disabled:opacity-60 dark:bg-stone-100 dark:text-stone-900 dark:hover:bg-white"
                aria-label="Salva artefatto nelle note"
              >
                <Download className="h-3.5 w-3.5" />
                <span>{isSaving ? 'Salvando...' : 'Salva'}</span>
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
};

const ChatArtifactRenderer = ({
  artifacts,
  className = 'mt-3 grid gap-2 sm:grid-cols-2',
  isDarkMode,
  isLoading = false,
  onDiscardArtifact,
  onRegenerateArtifact,
  onRemoveArtifact,
  onSaveArtifact,
}: ChatArtifactRendererProps) => {
  const [openArtifactId, setOpenArtifactId] = useState<string | null>(null);

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

  const openArtifact =
    deduplicatedArtifacts.find(artifact => artifact.summary.id === openArtifactId) || null;
  const artifactOverlay = openArtifact ? (
    <ArtifactOverlay
      artifact={openArtifact}
      isDarkMode={isDarkMode}
      onClose={() => setOpenArtifactId(null)}
      onDiscardArtifact={onDiscardArtifact}
      onRegenerateArtifact={onRegenerateArtifact}
      onSaveArtifact={onSaveArtifact}
    />
  ) : null;

  if (artifacts.length === 0 && !isLoading) {
    return null;
  }

  return (
    <div className={className}>
      {isLoading ? (
        <div className="col-span-full flex items-center gap-2 rounded-2xl border border-stone-200/90 bg-white/85 p-4 text-sm text-stone-500 dark:border-zinc-700/80 dark:bg-stone-800/75 dark:text-zinc-400">
          <div className="h-4 w-4 animate-spin rounded-full border-2 border-orange-500 border-t-transparent" />
          <span>Generazione artefatto in corso...</span>
        </div>
      ) : (
        deduplicatedArtifacts.map(artifact => {
          const Icon = getArtifactIcon(artifact);
          const hasPreview = artifact.summary.previewMode === 'thumbnail';
          return (
            <button
              key={artifact.summary.id}
              type="button"
              onClick={() => setOpenArtifactId(artifact.summary.id)}
              className="group min-w-0 rounded-2xl border border-stone-200/90 bg-white/85 p-2.5 text-left shadow-sm transition-colors hover:border-orange-200 hover:bg-orange-50/45 dark:border-zinc-700/80 dark:bg-stone-800/75 dark:hover:border-orange-500/40 dark:hover:bg-orange-500/10"
              aria-label={`Apri ${artifact.summary.title}`}
            >
              <ArtifactPreview artifact={artifact} isDarkMode={isDarkMode} />
              <span className={`${hasPreview ? 'mt-2' : ''} flex min-w-0 items-start gap-2`}>
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
                {onRemoveArtifact ? (
                  <button
                    type="button"
                    onClick={e => {
                      e.stopPropagation();
                      onRemoveArtifact(artifact.summary.id);
                    }}
                    className="mt-1 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-lg text-stone-400 transition-colors hover:bg-red-50 hover:text-red-600 dark:text-zinc-500 dark:hover:bg-stone-700 dark:hover:text-red-300"
                    aria-label={`Rimuovi ${artifact.summary.title}`}
                    title="Rimuovi dalla nota"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                ) : null}
              </span>
            </button>
          );
        })
      )}

      {artifactOverlay && typeof document !== 'undefined'
        ? createPortal(artifactOverlay, document.body)
        : artifactOverlay}
    </div>
  );
};

export default memo(ChatArtifactRenderer);
