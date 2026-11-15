import { buildLearningArtifactId } from '@shared/learningArtifact';
import type { LessonPlaybackBlock } from '@shared/lessonPlayback';
import type { LessonScene } from '@shared/lessonScene';
import type { PlaybackWordAlignment } from '@shared/playbackWordTiming';
import { AnimatePresence, motion, useIsPresent } from 'framer-motion';
import { Bookmark, Trash2 } from 'lucide-react';
import { type ReactNode, type RefObject, useCallback, useMemo, useRef, useState } from 'react';
import { translateUiMessage as t } from '../../../i18n/uiMessages.ts';
import type { LessonGeneratedVisual } from '../../../types.ts';
import { TRANSITION_FADE } from '../../../utils/motion/tokens.ts';
import { useShouldAnimate } from '../../../utils/motion/useShouldAnimate.ts';
import { playbackSentenceSelector } from '../../../utils/reader/lessonPlayback.ts';
import {
  getStoredLessonVisualScene,
  isUserGeneratedLessonArtifact,
} from '../../../utils/visuals/storedLessonVisual.ts';
import type { WorkspaceReaderContentModel } from '../shell/types.ts';
import { usePlaybackVisualFit } from './usePlaybackVisualFit.ts';

const sceneIdentity = (scene: LessonScene | null) =>
  JSON.stringify(scene, (_key, value: unknown) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
        )
      : value
  );

/** HTML frames and reduced motion release the previous visual immediately. */
export function PlaybackVisualPresence({
  enabled,
  children,
}: Readonly<{ enabled: boolean; children: ReactNode }>) {
  return enabled ? <AnimatePresence initial={false}>{children}</AnimatePresence> : children;
}

/** Keeps the saved scene in the course's existing artifact collection. */
export function SaveablePlaybackVisual({
  children,
  hasVisual = true,
  scene,
  block,
  content,
  cardRef,
  visualIndex,
  playback,
}: Readonly<{
  children: ReactNode;
  hasVisual?: boolean;
  scene: LessonScene | null;
  block: LessonPlaybackBlock;
  content: WorkspaceReaderContentModel;
  cardRef: RefObject<HTMLElement | null>;
  visualIndex: number;
  playback: {
    lessonKey: string;
    readTime: () => number;
    duration: number;
    alignment?: PlaybackWordAlignment;
  };
}>) {
  const present = useIsPresent();
  const animate = useShouldAnimate();
  const { cardRef: fittedCardRef, ready } = usePlaybackVisualFit(present);
  const attachCard = useCallback(
    (node: HTMLElement | null) => {
      const previous = fittedCardRef.current;
      fittedCardRef.current = node;
      if (present && (node || cardRef.current === previous)) cardRef.current = node;
    },
    [cardRef, fittedCardRef, present]
  );
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [tapped, setTapped] = useState(false);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState<string>();
  const sceneKey = useMemo(() => sceneIdentity(scene), [scene]);
  // Identical scenes in different playback occurrences remain independent artifacts.
  const sourceIdPrefix = `visual-draft-playback-${encodeURIComponent(playback.lessonKey)}-${encodeURIComponent(block.id)}-${visualIndex}-`;
  const saved = useMemo(
    () =>
      Object.values(content.activeSectionGeneratedVisualsById ?? {}).find(
        visual =>
          isUserGeneratedLessonArtifact(visual) &&
          visual.id.startsWith(sourceIdPrefix) &&
          sceneIdentity(getStoredLessonVisualScene(visual)) === sceneKey
      ),
    [content.activeSectionGeneratedVisualsById, sourceIdPrefix, sceneKey]
  );
  const enabled = !!(
    hasVisual &&
    playback.lessonKey &&
    scene &&
    content.projectId &&
    content.activeSectionId &&
    content.onSavePlaybackVisual &&
    content.onRemovePlaybackVisual
  );
  const visible = enabled && (hovered || focused || tapped);
  const toggleSaved = async () => {
    if (
      pending.current ||
      !playback.lessonKey ||
      !scene ||
      !content.projectId ||
      !content.activeSectionId ||
      !content.onSavePlaybackVisual ||
      !content.onRemovePlaybackVisual
    )
      return;
    pending.current = true;
    setBusy(true);
    setError(undefined);
    const target = { projectId: content.projectId, lessonId: content.activeSectionId };
    try {
      if (saved) {
        const result = await content.onRemovePlaybackVisual(target, saved.id);
        if (!result.succeeded) setError(result.error);
      } else {
        const visual: LessonGeneratedVisual = {
          id: `${sourceIdPrefix}${crypto.randomUUID()}`,
          title: scene.title || block.heading || t('Visualizzazione della lezione'),
          kind: 'scene',
          code: '',
          scene,
          anchorHeading: block.heading,
          createdAt: new Date().toISOString(),
        };
        const passage = playbackSentenceSelector(
          block,
          playback.readTime(),
          playback.duration,
          content.sectionContentBlocks?.length
            ? content.sectionContentBlocks
            : [{ type: 'markdown', markdown: content.sectionContent }],
          playback.alignment
        );
        const result = await content.onSavePlaybackVisual(
          target,
          visual,
          {
            artifactId: buildLearningArtifactId({
              ...target,
              artifactId: visual.id,
              kind: 'generated-visual',
            }),
            kind: 'generated-visual',
            title: visual.title,
          },
          passage ?? undefined
        );
        if (!result.succeeded) setError(result.error);
      }
    } catch {
      setError(
        t(
          saved
            ? "Non sono riuscito a rimuovere l'artefatto."
            : "Non sono riuscito a salvare l'artefatto."
        )
      );
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  return (
    <motion.section
      ref={attachCard}
      initial={{ opacity: 0 }}
      animate={{ opacity: ready ? 1 : 0 }}
      exit={{ opacity: 0 }}
      transition={animate ? TRANSITION_FADE : { duration: 0 }}
      style={{ pointerEvents: present ? undefined : 'none' }}
      className="scene-host"
      data-exiting={present ? undefined : true}
      inert={!present}
      aria-hidden={!hasVisual || !present}
      aria-label={t('Visualizzazione della lezione')}
      tabIndex={enabled ? 0 : undefined}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={event => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setFocused(false);
          setTapped(false);
        }
      }}
      onPointerDown={event => {
        if (event.pointerType === 'touch' && !(event.target as Element).closest('button'))
          setTapped(true);
      }}
    >
      {children}
      {visible ? (
        <span className="playback-visual-action">
          <button
            type="button"
            aria-disabled={busy}
            onClick={() => void toggleSaved()}
            className="inline-flex items-center gap-2 rounded-full border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-3 py-1 text-sm font-medium text-[var(--ink-primary)] shadow-sm aria-disabled:opacity-50"
          >
            {saved ? (
              <Trash2 size={14} aria-hidden="true" />
            ) : (
              <Bookmark size={14} aria-hidden="true" />
            )}
            {saved ? t('Rimuovi') : t('Salva')}
          </button>
        </span>
      ) : null}
      {error ? (
        <p role="alert" className="playback-visual-error">
          {error}
        </p>
      ) : null}
    </motion.section>
  );
}
