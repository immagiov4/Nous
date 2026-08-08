import { useEffect, useState } from 'react';

import {
  asLegacyProjectDocumentImage,
  type ResolvedProjectDocumentImage,
  resolveProjectDocumentImage,
} from '../services/projects/projectDocumentImageResolver.ts';
import type { PdfDocumentImageAsset } from '../types.ts';

interface ResolutionState {
  readonly image: PdfDocumentImageAsset;
  readonly projectId?: string | null;
  readonly result?: ResolvedProjectDocumentImage;
  readonly status: 'failed' | 'loading' | 'ready';
}

export const useResolvedProjectDocumentImage = (
  image: PdfDocumentImageAsset,
  projectId?: string | null
): Pick<ResolutionState, 'result' | 'status'> => {
  const legacy = asLegacyProjectDocumentImage(image);
  const [state, setState] = useState<ResolutionState>(() => ({
    image,
    projectId,
    ...(legacy ? { result: legacy, status: 'ready' as const } : { status: 'loading' as const }),
  }));

  useEffect(() => {
    if (legacy) return;

    const controller = new AbortController();
    let release = () => {};
    void resolveProjectDocumentImage({ image, projectId, signal: controller.signal })
      .then(result => {
        if (controller.signal.aborted) {
          result.release();
          return;
        }
        release = result.release;
        setState({ image, projectId, result, status: 'ready' });
      })
      .catch(error => {
        if (controller.signal.aborted) return;
        console.error('[Nous] PDF image resolution failed.', {
          errorType: error instanceof Error ? error.name : 'UnknownError',
          imageId: image.id,
        });
        setState({ image, projectId, status: 'failed' });
      });

    return () => {
      controller.abort();
      release();
    };
  }, [image, legacy, projectId]);

  if (legacy) return { result: legacy, status: 'ready' };

  if (state.image !== image || state.projectId !== projectId) return { status: 'loading' };
  return { result: state.result, status: state.status };
};
