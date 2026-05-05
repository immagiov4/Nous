import { FileImage, Maximize2, MousePointerClick, Network, X } from 'lucide-react';
import { memo, useEffect, useState } from 'react';

import type { LearningArtifactRenderPayload } from '../../types.ts';
import GeneratedVisualFrame from './GeneratedVisualFrame.tsx';

interface ChatArtifactRendererProps {
  artifacts: LearningArtifactRenderPayload[];
  isDarkMode: boolean;
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
}: {
  artifact: LearningArtifactRenderPayload;
  isDarkMode: boolean;
  onClose: () => void;
}) => {
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
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 p-3 sm:p-6">
      <button
        type="button"
        aria-label="Chiudi anteprima artefatto"
        className="absolute inset-0 cursor-default"
        onClick={onClose}
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
            onClick={onClose}
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-stone-400 transition-colors hover:bg-stone-100 hover:text-stone-700 dark:text-zinc-500 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
            aria-label="Chiudi artefatto"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-4 sm:p-6">
          {'image' in artifact ? (
            <img
              src={artifact.image.dataUrl}
              alt={artifact.summary.title}
              className="mx-auto block max-h-[72dvh] max-w-full rounded-xl object-contain"
            />
          ) : 'visual' in artifact ? (
            <GeneratedVisualFrame
              isDarkMode={isDarkMode}
              title={artifact.summary.title}
              visual={artifact.visual}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
};

const ChatArtifactRenderer = ({ artifacts, isDarkMode }: ChatArtifactRendererProps) => {
  const [openArtifactId, setOpenArtifactId] = useState<string | null>(null);
  const openArtifact = artifacts.find(artifact => artifact.summary.id === openArtifactId) || null;

  if (artifacts.length === 0) {
    return null;
  }

  return (
    <div className="mt-3 grid gap-2 sm:grid-cols-2">
      {artifacts.map(artifact => {
        const Icon = getArtifactIcon(artifact);
        return (
          <button
            key={artifact.summary.id}
            type="button"
            onClick={() => setOpenArtifactId(artifact.summary.id)}
            className="group min-w-0 rounded-2xl border border-stone-200/90 bg-white/85 p-2.5 text-left shadow-sm transition-colors hover:border-orange-200 hover:bg-orange-50/45 dark:border-zinc-700/80 dark:bg-stone-800/75 dark:hover:border-orange-500/40 dark:hover:bg-orange-500/10"
            aria-label={`Apri ${artifact.summary.title}`}
          >
            <ArtifactPreview artifact={artifact} isDarkMode={isDarkMode} />
            <span className="mt-2 flex min-w-0 items-start gap-2">
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
              <Maximize2 className="mt-1 h-3.5 w-3.5 shrink-0 text-stone-300 transition-colors group-hover:text-orange-500 dark:text-zinc-600 dark:group-hover:text-orange-300" />
            </span>
          </button>
        );
      })}

      {openArtifact ? (
        <ArtifactOverlay
          artifact={openArtifact}
          isDarkMode={isDarkMode}
          onClose={() => setOpenArtifactId(null)}
        />
      ) : null}
    </div>
  );
};

export default memo(ChatArtifactRenderer);
