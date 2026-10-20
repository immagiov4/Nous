import {
  hasConflictingLessonSceneClosingText,
  isAnimatedLessonScene,
  isQuickLessonScene,
  LESSON_SCENE_RELATION_SYMBOLS,
  type LessonScene,
} from '@shared/lessonScene';
import { useContext } from 'react';

import { translateUiMessage as t } from '../../../i18n/uiMessages.ts';
import type { ReadSceneAnimationFrame } from './AnimatedScene.tsx';
import type { SceneRenderContext } from './lessonSceneRendering.tsx';
import { SceneIcon, SceneIconProvider, ScenePrototypeContext } from './SceneIcon.tsx';
import { SCENE_RENDERERS } from './sceneRenderers.tsx';
import './lessonScene.css';

/** Prototype lesson layouts: the web renderer map follows the shared scene catalog. */

const SceneContent = (
  props: Pick<SceneRenderContext, 'scene' | 'isDarkMode' | 'readFrame' | 'playback'>
) =>
  SCENE_RENDERERS[props.scene.type]({
    ...props,
    prototype: useContext(ScenePrototypeContext),
    labels: { comparison: t('confronto'), criterion: t('Criterio'), becomes: t('diventa') },
    relationSymbols: LESSON_SCENE_RELATION_SYMBOLS,
  });

export const LessonSceneVisual = ({
  className = '',
  isDarkMode = false,
  scene,
  readAnimationFrame,
  variant = 'card',
}: {
  readonly className?: string;
  readonly isDarkMode?: boolean;
  readonly scene: LessonScene;
  readonly readAnimationFrame?: ReadSceneAnimationFrame;
  readonly variant?: 'card' | 'bare';
}) => (
  <figure
    className={`lesson-scene ${variant === 'bare' ? 'lesson-scene-bare' : ''} ${isAnimatedLessonScene(scene) ? 'lesson-scene-animated' : ''} ${className}`}
    data-nous-speech="ignore"
  >
    <SceneIconProvider prototype={variant === 'bare' || isAnimatedLessonScene(scene)}>
      <article
        className={`scene type-${scene.type}${isAnimatedLessonScene(scene) ? ' interaction-card' : ''}${isQuickLessonScene(scene) ? ' quick-scene' : ''}`}
      >
        <header>
          <h2>{scene.title}</h2>
          {scene.body && scene.type !== 'quote' ? (
            <p className={isAnimatedLessonScene(scene) ? undefined : 'scene-intro'}>{scene.body}</p>
          ) : null}
        </header>
        {isAnimatedLessonScene(scene) ? (
          <SceneContent
            playback={variant === 'bare'}
            isDarkMode={isDarkMode}
            scene={scene}
            readFrame={readAnimationFrame}
          />
        ) : (
          <div className="visual-content">
            <SceneContent
              playback={variant === 'bare'}
              isDarkMode={isDarkMode}
              scene={scene}
              readFrame={readAnimationFrame}
            />
          </div>
        )}
        {/* The reader omits conflicting closing text; the player follows the laboratory scene. */}
        {scene.quote.trim() &&
        scene.type !== 'quote' &&
        scene.type !== 'decision' &&
        (variant === 'bare' || !hasConflictingLessonSceneClosingText(scene)) ? (
          <aside aria-label={t('Domanda')} className="scene-note scenario-question">
            <SceneIcon name="help-circle" />
            <p>{scene.quote}</p>
          </aside>
        ) : null}
        {scene.note.trim() &&
        (variant === 'bare' || !hasConflictingLessonSceneClosingText(scene)) ? (
          <aside aria-label={t('Nota')} className="scene-note">
            <SceneIcon name="info-circle" />
            <p>{scene.note}</p>
          </aside>
        ) : null}
      </article>
    </SceneIconProvider>
  </figure>
);
