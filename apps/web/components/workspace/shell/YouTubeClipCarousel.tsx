import { Play } from 'lucide-react';
import { type KeyboardEvent, useId, useMemo, useRef, useState } from 'react';
import { translateUiMessage as t } from '../../../i18n/uiMessages.ts';
import type { LessonYouTubeClip } from '../../../types.ts';
import { buildYouTubeClipEmbedUrl } from '../../../utils/youtube.ts';

const formatClipTime = (seconds: number): string => {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
};

const formatClipRange = (clip: LessonYouTubeClip): string =>
  `${formatClipTime(clip.startSeconds)}–${formatClipTime(clip.endSeconds)}`;

interface CarouselState {
  isPlayerVisible: boolean;
  selectedIndex: number;
  sequenceIdentity: string;
}

const buildClipSequenceIdentity = (clips: LessonYouTubeClip[]): string =>
  JSON.stringify(
    clips.map(clip => ({
      endSeconds: clip.endSeconds,
      sourceIndex: clip.sourceIndex,
      startSeconds: clip.startSeconds,
      url: clip.url,
    }))
  );

export default function YouTubeClipCarousel({ clips }: { clips: LessonYouTubeClip[] }) {
  const carouselId = useId();
  const tabListRef = useRef<HTMLDivElement>(null);
  const sequenceIdentity = useMemo(() => buildClipSequenceIdentity(clips), [clips]);
  const [carouselState, setCarouselState] = useState<CarouselState>(() => ({
    isPlayerVisible: false,
    selectedIndex: 0,
    sequenceIdentity,
  }));
  const currentState =
    carouselState.sequenceIdentity === sequenceIdentity
      ? carouselState
      : { isPlayerVisible: false, selectedIndex: 0, sequenceIdentity };
  const activeIndex = Math.min(currentState.selectedIndex, Math.max(0, clips.length - 1));
  const activeClip = clips[activeIndex];
  if (!activeClip) {
    return null;
  }

  const embedUrl = buildYouTubeClipEmbedUrl(
    activeClip.url,
    activeClip.startSeconds,
    activeClip.endSeconds
  );
  if (!embedUrl) {
    return null;
  }

  const selectClip = (nextIndex: number) => {
    if (nextIndex === activeIndex || !clips[nextIndex]) {
      return;
    }
    setCarouselState({
      isPlayerVisible: false,
      selectedIndex: nextIndex,
      sequenceIdentity,
    });
  };
  const selectAndFocusClip = (nextIndex: number) => {
    selectClip(nextIndex);
    tabListRef.current?.querySelectorAll<HTMLElement>('[role="tab"]')[nextIndex]?.focus();
  };
  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, tabIndex: number) => {
    let nextIndex: number | null = null;
    if (event.key === 'ArrowRight') nextIndex = (tabIndex + 1) % clips.length;
    if (event.key === 'ArrowLeft') nextIndex = (tabIndex - 1 + clips.length) % clips.length;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = clips.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    selectAndFocusClip(nextIndex);
  };
  const activeTimeRange = formatClipRange(activeClip);
  const playerPanelId = `${carouselId}-player`;
  const hasMultipleClips = clips.length > 1;

  return (
    <section className="overflow-hidden rounded-[1.25rem] border border-stone-200/80 bg-white/80 dark:border-stone-700 dark:bg-stone-900/35">
      <div id={playerPanelId} role="tabpanel" aria-label={activeClip.title}>
        {currentState.isPlayerVisible ? (
          <iframe
            src={embedUrl}
            title={t('Dimostrazione video: {sourceTitle}', { sourceTitle: activeClip.title })}
            allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
            allowFullScreen
            loading="lazy"
            referrerPolicy="strict-origin-when-cross-origin"
            className="aspect-video w-full border-0"
          />
        ) : (
          <button
            type="button"
            aria-label={t('Riproduci la dimostrazione ({timeRange})', {
              timeRange: activeTimeRange,
            })}
            onClick={() =>
              setCarouselState({
                ...currentState,
                isPlayerVisible: true,
                sequenceIdentity,
              })
            }
            className="flex aspect-video w-full flex-col items-center justify-center gap-3 bg-stone-100 px-6 text-stone-800 transition-colors hover:bg-stone-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-4px] focus-visible:outline-orange-600 dark:bg-stone-950 dark:text-stone-100 dark:hover:bg-stone-900"
          >
            <span className="flex h-12 w-12 items-center justify-center rounded-full bg-orange-600 text-white">
              <Play className="ml-0.5 h-5 w-5" fill="currentColor" />
            </span>
            <span className="max-w-full truncate text-sm font-semibold">{activeClip.title}</span>
            <span className="text-xs font-medium tabular-nums text-stone-600 dark:text-stone-300">
              {activeTimeRange}
            </span>
          </button>
        )}
      </div>

      {hasMultipleClips ? (
        <div
          ref={tabListRef}
          role="tablist"
          aria-label={t('Micro-capitoli video')}
          className="flex snap-x overflow-x-auto border-t border-stone-200/80 dark:border-stone-700"
        >
          {clips.map((clip, index) => {
            const isSelected = index === activeIndex;
            return (
              <button
                key={clip.id}
                type="button"
                role="tab"
                aria-controls={playerPanelId}
                aria-label={`${clip.title}, ${formatClipRange(clip)}`}
                aria-selected={isSelected}
                tabIndex={isSelected ? 0 : -1}
                onClick={() => selectClip(index)}
                onKeyDown={event => handleTabKeyDown(event, index)}
                className={`min-w-[10rem] flex-1 snap-start border-l border-stone-200/80 px-3 py-2.5 text-left first:border-l-0 focus-visible:z-10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-3px] focus-visible:outline-orange-600 dark:border-stone-700 ${
                  isSelected
                    ? 'bg-white text-stone-900 dark:bg-stone-900 dark:text-stone-100'
                    : 'bg-stone-200/75 text-stone-600 hover:bg-stone-200 hover:text-stone-800 dark:bg-stone-800 dark:text-stone-300 dark:hover:bg-stone-700 dark:hover:text-stone-100'
                }`}
              >
                <span className="block truncate text-sm font-semibold">{clip.title}</span>
                <span className="mt-0.5 block text-xs font-medium tabular-nums text-stone-500 dark:text-stone-400">
                  {formatClipRange(clip)}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
    </section>
  );
}
