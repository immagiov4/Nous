import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from 'react';
import { translateUiMessage as t } from '../../../i18n/uiMessages.ts';
import type { LessonYouTubeClip } from '../../../types.ts';
import { buildYouTubeClipEmbedUrl, extractYouTubeVideoId } from '../../../utils/youtube.ts';

const formatClipTime = (seconds: number): string => {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
};

const formatClipRange = (clip: LessonYouTubeClip): string =>
  `${formatClipTime(clip.startSeconds)}–${formatClipTime(clip.endSeconds)}`;

interface CarouselState {
  playerIndex: number;
  selectedIndex: number;
  sequenceIdentity: string;
  shouldAutoplay: boolean;
}

const YOUTUBE_EMBED_ORIGIN = 'https://www.youtube-nocookie.com';

interface PendingClipCommand {
  clip: LessonYouTubeClip;
  sequenceIdentity: string;
  videoId: string;
}

const readYouTubePlayerEvent = (value: unknown): string | null => {
  try {
    const parsed = typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
    if (!parsed || typeof parsed !== 'object') return null;
    const event = (parsed as { event?: unknown }).event;
    return typeof event === 'string' ? event : null;
  } catch {
    return null;
  }
};

const playClipInExistingPlayer = (player: HTMLIFrameElement, clip: LessonYouTubeClip): void => {
  const videoId = extractYouTubeVideoId(clip.url);
  if (!videoId) return;

  player.contentWindow?.postMessage(
    JSON.stringify({
      event: 'command',
      func: 'loadVideoById',
      args: [
        {
          endSeconds: clip.endSeconds,
          startSeconds: clip.startSeconds,
          videoId,
        },
      ],
    }),
    YOUTUBE_EMBED_ORIGIN
  );
};

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
  const playerRef = useRef<HTMLIFrameElement>(null);
  const loadedPlayerUrlRef = useRef<string | null>(null);
  const playerReadyRef = useRef(false);
  const pendingClipRef = useRef<PendingClipCommand | null>(null);
  const tabListRef = useRef<HTMLDivElement>(null);
  const sequenceIdentity = useMemo(() => buildClipSequenceIdentity(clips), [clips]);
  const [carouselState, setCarouselState] = useState<CarouselState>(() => ({
    playerIndex: 0,
    selectedIndex: 0,
    sequenceIdentity,
    shouldAutoplay: false,
  }));
  const currentState =
    carouselState.sequenceIdentity === sequenceIdentity
      ? carouselState
      : { playerIndex: 0, selectedIndex: 0, sequenceIdentity, shouldAutoplay: false };
  const activeIndex = Math.min(currentState.selectedIndex, Math.max(0, clips.length - 1));
  const playerIndex = Math.min(currentState.playerIndex, Math.max(0, clips.length - 1));
  const activeClip = clips[activeIndex];
  const playerClip = clips[playerIndex];
  const playerVideoId = playerClip ? extractYouTubeVideoId(playerClip.url) : null;
  useEffect(() => {
    const handlePlayerMessage = (event: MessageEvent) => {
      const player = playerRef.current;
      if (
        event.origin !== YOUTUBE_EMBED_ORIGIN ||
        !player?.contentWindow ||
        event.source !== player.contentWindow ||
        readYouTubePlayerEvent(event.data) !== 'onReady'
      ) {
        return;
      }

      playerReadyRef.current = true;
      const pending = pendingClipRef.current;
      if (pending?.sequenceIdentity === sequenceIdentity && pending.videoId === playerVideoId) {
        playClipInExistingPlayer(player, pending.clip);
        pendingClipRef.current = null;
      }
    };
    globalThis.addEventListener('message', handlePlayerMessage);
    return () => globalThis.removeEventListener('message', handlePlayerMessage);
  }, [playerVideoId, sequenceIdentity]);
  if (!activeClip || !playerClip) {
    return null;
  }

  const embedUrl = buildYouTubeClipEmbedUrl(
    playerClip.url,
    playerClip.startSeconds,
    playerClip.endSeconds,
    currentState.shouldAutoplay
  );
  if (!embedUrl) {
    return null;
  }

  const selectClip = (nextIndex: number) => {
    const nextClip = clips[nextIndex];
    if (nextIndex === activeIndex || !nextClip) {
      return;
    }

    const staysOnCurrentVideo =
      extractYouTubeVideoId(nextClip.url) === extractYouTubeVideoId(playerClip.url);
    if (staysOnCurrentVideo && playerRef.current) {
      if (loadedPlayerUrlRef.current === embedUrl && playerReadyRef.current) {
        playClipInExistingPlayer(playerRef.current, nextClip);
      } else {
        const videoId = extractYouTubeVideoId(nextClip.url);
        pendingClipRef.current = videoId ? { clip: nextClip, sequenceIdentity, videoId } : null;
      }
    } else {
      loadedPlayerUrlRef.current = null;
      playerReadyRef.current = false;
      pendingClipRef.current = null;
    }
    setCarouselState({
      playerIndex: staysOnCurrentVideo ? playerIndex : nextIndex,
      selectedIndex: nextIndex,
      sequenceIdentity,
      shouldAutoplay: staysOnCurrentVideo ? currentState.shouldAutoplay : true,
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
  const playerPanelId = `${carouselId}-player`;
  const hasMultipleClips = clips.length > 1;

  return (
    <section className="overflow-hidden rounded-[1.25rem] border border-stone-200/80 bg-white/80 dark:border-stone-700 dark:bg-stone-900/35">
      <div id={playerPanelId} role="tabpanel" aria-label={activeClip.title}>
        <iframe
          key={playerVideoId}
          ref={playerRef}
          src={embedUrl}
          title={t('Dimostrazione video: {sourceTitle}', { sourceTitle: activeClip.title })}
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
          allowFullScreen
          loading="lazy"
          onLoad={() => {
            loadedPlayerUrlRef.current = embedUrl;
            playerReadyRef.current = false;
            playerRef.current?.contentWindow?.postMessage(
              JSON.stringify({ event: 'listening', id: carouselId }),
              YOUTUBE_EMBED_ORIGIN
            );
          }}
          referrerPolicy="strict-origin-when-cross-origin"
          className="aspect-video w-full border-0"
        />
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
