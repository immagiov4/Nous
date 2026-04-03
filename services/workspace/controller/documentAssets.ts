import type { LearningPlan, PdfDocumentAssets, PdfImageAsset } from '../../../types.ts';

export const mergeDocumentAssetsForPlan = (
  nextPlan: LearningPlan,
  currentAssets: PdfDocumentAssets | null,
  incomingAssets: PdfDocumentAssets | null
): PdfDocumentAssets | null => {
  const template = incomingAssets || currentAssets;
  if (!template) {
    return null;
  }

  const referencedAssetIds = new Set(
    nextPlan.sections.flatMap(section => (section.imageRefs || []).map(imageRef => imageRef.assetId))
  );
  const availableAssets = new Map<string, PdfImageAsset>();

  currentAssets?.usedImages.forEach(asset => {
    availableAssets.set(asset.id, asset);
  });
  incomingAssets?.usedImages.forEach(asset => {
    availableAssets.set(asset.id, asset);
  });

  return {
    kind: 'pdf',
    parsedAt: incomingAssets?.parsedAt || currentAssets?.parsedAt || template.parsedAt,
    imageCount: incomingAssets?.imageCount ?? currentAssets?.imageCount ?? template.imageCount,
    sourceHash: incomingAssets?.sourceHash || currentAssets?.sourceHash,
    usedImages: Array.from(referencedAssetIds)
      .map(assetId => availableAssets.get(assetId))
      .filter((asset): asset is PdfImageAsset => Boolean(asset)),
  };
};
