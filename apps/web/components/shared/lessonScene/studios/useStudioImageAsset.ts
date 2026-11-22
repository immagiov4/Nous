import type { ProjectAssetRef } from '@shared/projectAsset';
import { useEffect, useState } from 'react';
import { resolveProjectImageAsset } from '../../../../services/projects/projectVisualResolver.ts';

type ImageResolution = { assetId: string; projectId: string; url?: string };

/** Resolve through project storage and release the object URL on navigation or replacement. */
export function useStudioImageAsset(asset?: ProjectAssetRef, projectId?: string | null) {
  const [image, setImage] = useState<ImageResolution>();
  useEffect(() => {
    if (!asset || !projectId) return;
    const controller = new AbortController();
    let release: (() => void) | undefined;
    void resolveProjectImageAsset(projectId, asset, controller.signal)
      .then(async resource => {
        if (controller.signal.aborted) {
          resource.release();
          return;
        }
        release = resource.release;
        const raster = new Image();
        raster.src = resource.url;
        await raster.decode();
        if (!controller.signal.aborted)
          setImage({ assetId: asset.id, projectId, url: resource.url });
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        release?.();
        release = undefined;
        setImage({ assetId: asset.id, projectId });
      });
    return () => {
      controller.abort();
      release?.();
    };
  }, [asset, projectId]);
  const currentImage =
    image?.assetId === asset?.id && image?.projectId === projectId ? image : undefined;
  return {
    url: currentImage?.url,
    unavailable: Boolean(asset && (!projectId || (currentImage && !currentImage.url))),
  };
}
