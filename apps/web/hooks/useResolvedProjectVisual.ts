import { useEffect, useState } from 'react';

import {
  type ResolvedProjectVisual,
  resolveProjectVisual,
} from '../services/projects/projectVisualResolver.ts';
import type { StoredLessonVisual } from '../types.ts';
import { asLegacyLessonVisual } from '../utils/visuals/storedLessonVisual.ts';

interface ResolutionState {
  readonly projectId?: string | null;
  readonly result?: ResolvedProjectVisual;
  readonly status: 'failed' | 'loading' | 'ready';
  readonly source: StoredLessonVisual;
}

export const useResolvedProjectVisual = (
  visual: StoredLessonVisual,
  projectId?: string | null
): Omit<ResolutionState, 'projectId' | 'source'> => {
  const legacyVisual = asLegacyLessonVisual(visual);
  const [state, setState] = useState<ResolutionState>(() => ({
    projectId,
    ...(legacyVisual
      ? {
          result: { release: () => {}, trustedImageUrl: false, visual: legacyVisual },
          status: 'ready' as const,
        }
      : { status: 'loading' as const }),
    source: visual,
  }));

  useEffect(() => {
    if (legacyVisual) return;

    const controller = new AbortController();
    let release = () => {};
    void resolveProjectVisual({ projectId, signal: controller.signal, visual })
      .then(result => {
        if (controller.signal.aborted) {
          result.release();
          return;
        }
        release = result.release;
        setState({ projectId, result, source: visual, status: 'ready' });
      })
      .catch(error => {
        if (controller.signal.aborted) return;
        console.error('[Nous] Project visual resolution failed.', {
          errorType: error instanceof Error ? error.name : 'UnknownError',
          visualId: visual.id,
        });
        setState({ projectId, source: visual, status: 'failed' });
      });

    return () => {
      controller.abort();
      release();
    };
  }, [legacyVisual, projectId, visual]);

  if (legacyVisual) {
    return {
      result: { release: () => {}, trustedImageUrl: false, visual: legacyVisual },
      status: 'ready',
    };
  }
  if (state.source !== visual || state.projectId !== projectId) {
    return { status: 'loading' };
  }
  return { result: state.result, status: state.status };
};
