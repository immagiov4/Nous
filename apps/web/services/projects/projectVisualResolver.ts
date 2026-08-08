import {
  buildProjectAssetPlaceholder,
  type ProjectAssetRef,
  type ProjectLessonVisual,
  validateProjectAssetHtmlReferences,
} from '@shared/projectAsset';

import type { LessonGeneratedVisual, StoredLessonVisual } from '../../types.ts';
import { isProjectLessonVisual } from '../../utils/visuals/storedLessonVisual.ts';
import { downloadProjectAssetBytes } from './projectAssetClient.ts';

type ResolutionErrorCode =
  | 'asset-reference-invalid'
  | 'project-id-missing'
  | 'visual-placeholder-invalid';

export class ProjectVisualResolutionError extends Error {
  constructor(readonly code: ResolutionErrorCode) {
    super(`Project visual resolution failed: ${code}.`);
    this.name = 'ProjectVisualResolutionError';
  }
}

export interface ResolvedProjectVisual {
  readonly release: () => void;
  readonly trustedImageUrl: boolean;
  readonly visual: LessonGeneratedVisual;
}

interface DownloadedProjectAsset {
  readonly bytes: Uint8Array;
  readonly ref: ProjectAssetRef;
}

const downloadProjectAsset = async (
  projectId: string,
  ref: ProjectAssetRef,
  signal: AbortSignal
): Promise<DownloadedProjectAsset> => ({
  bytes: await downloadProjectAssetBytes(projectId, ref, signal),
  ref,
});

const createObjectUrl = (asset: DownloadedProjectAsset): string =>
  URL.createObjectURL(
    new Blob([Uint8Array.from(asset.bytes).buffer], { type: asset.ref.mediaType })
  );

const toLegacyVisual = (
  visual: ProjectLessonVisual,
  kind: LessonGeneratedVisual['kind'],
  code: string
): LessonGeneratedVisual => ({
  ...(visual.altText ? { altText: visual.altText } : {}),
  ...(visual.anchorHeading ? { anchorHeading: visual.anchorHeading } : {}),
  code,
  createdAt: visual.createdAt,
  id: visual.id,
  kind,
  title: visual.title || '',
});

const resolveHtmlVisual = async (
  projectId: string,
  visual: ProjectLessonVisual,
  signal: AbortSignal
): Promise<ResolvedProjectVisual> => {
  if (visual.render.kind !== 'html') {
    throw new ProjectVisualResolutionError('asset-reference-invalid');
  }
  const validation = validateProjectAssetHtmlReferences(
    visual.render.code,
    visual.render.embeddedAssets
  );
  if (!validation.valid) {
    throw new ProjectVisualResolutionError(
      validation.reason === 'asset-reference-invalid'
        ? 'asset-reference-invalid'
        : 'visual-placeholder-invalid'
    );
  }
  const downloads = await Promise.all(
    Array.from(validation.refsById.values(), ref => downloadProjectAsset(projectId, ref, signal))
  );
  const urlsById = new Map<string, string>();
  try {
    downloads.forEach(asset => {
      urlsById.set(asset.ref.id, createObjectUrl(asset));
    });
  } catch (error) {
    urlsById.forEach(url => {
      URL.revokeObjectURL(url);
    });
    throw error;
  }
  let code = visual.render.code;
  urlsById.forEach((url, assetId) => {
    code = code.split(buildProjectAssetPlaceholder(assetId)).join(url);
  });
  return {
    release: () => {
      urlsById.forEach(url => {
        URL.revokeObjectURL(url);
      });
    },
    trustedImageUrl: false,
    visual: toLegacyVisual(visual, 'html', code),
  };
};

export const resolveProjectVisual = async ({
  projectId,
  signal,
  visual,
}: {
  readonly projectId?: string | null;
  readonly signal: AbortSignal;
  readonly visual: StoredLessonVisual;
}): Promise<ResolvedProjectVisual> => {
  if (!isProjectLessonVisual(visual)) {
    return { release: () => {}, trustedImageUrl: false, visual };
  }
  if (!projectId?.trim()) {
    throw new ProjectVisualResolutionError('project-id-missing');
  }
  if (visual.render.kind === 'html') {
    return resolveHtmlVisual(projectId, visual, signal);
  }
  if (visual.render.kind !== 'image') {
    return {
      release: () => {},
      trustedImageUrl: false,
      visual: toLegacyVisual(visual, visual.render.kind, visual.render.code),
    };
  }

  const asset = await downloadProjectAsset(projectId, visual.render.asset, signal);
  const url = createObjectUrl(asset);
  return {
    release: () => URL.revokeObjectURL(url),
    trustedImageUrl: true,
    visual: toLegacyVisual(visual, 'image', url),
  };
};
