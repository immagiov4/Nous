import { buildVisibleImageLabel, selectCandidatePdfImages } from '@shared/lessonPdfImageSelection';
import * as z from 'zod';

import type { ProjectAssetWriter } from '../projects/projectAsset.js';
import { findProjectLessonSection } from '../projects/projectLesson.js';
import type { ProjectSnapshot } from '../projects/types.js';
import type {
  LessonPdfImageAsset,
  LessonPdfImageExtractionOutcome,
} from '../services/lessonGenerationSources.js';
import {
  readExistingPdfImageAssets,
  readMappedPdfPages,
  readSectionSourceIds,
} from '../services/lessonGenerationSources.js';
import { buildSha256HexDigest } from '../utils/hash.js';
import { isRecord } from '../utils/validation.js';
import { buildLessonGenerationSourceFingerprint } from './lessonGenerationAuthority.js';
import type { LessonGenerationStageContext } from './lessonGenerationWorkflow.js';
import type {
  LessonCoverageState,
  LessonSourcesState,
} from './lessonGenerationWorkflowContract.js';
import {
  LessonGenerationWarningSchema,
  type LessonPdfImageMetadata,
  LessonPdfImageMetadataSchema,
  Sha256HexSchema,
} from './lessonGenerationWorkflowSchemas.js';
import { failPermanently } from './retryPolicy.js';

interface LessonDocumentSourceStageDependencies {
  readonly assets: Pick<ProjectAssetWriter, 'stage'>;
  readonly captionImage: (input: {
    context: LessonGenerationStageContext<LessonCoverageState>;
    image: LessonPdfImageAsset;
  }) => Promise<string | null>;
  readonly extractImages: (input: {
    context: LessonGenerationStageContext<LessonCoverageState>;
    project: ProjectSnapshot;
    section: Record<string, unknown>;
  }) => Promise<LessonPdfImageExtractionOutcome>;
  readonly loadProject: (userId: string, projectId: string) => Promise<ProjectSnapshot | null>;
}

const LessonPdfImageExtractionOutcomeSchema = z.object({
  assets: z.array(
    z.object({
      caption: z.string().optional(),
      dataUrl: z.string(),
      id: z.string(),
      intrinsicHeight: z.number().int().positive().optional(),
      intrinsicWidth: z.number().int().positive().optional(),
      mimeType: z.string(),
      pageNumber: z.number().int().positive().optional(),
      sizeBytes: z.number().int().nonnegative().optional(),
      sourceHash: Sha256HexSchema.optional(),
      sourceId: z.string().optional(),
      sourceOrder: z.number().int().nonnegative(),
      textAfter: z.string(),
      textBefore: z.string(),
      textCurrent: z.string().optional(),
    })
  ),
  warnings: z.array(LessonGenerationWarningSchema),
});

const DurableLessonPdfImageExtractionOutcomeSchema = z.object({
  assets: z.array(LessonPdfImageMetadataSchema),
  warnings: z.array(LessonGenerationWarningSchema),
});

const readDurablePdfImages = (project: ProjectSnapshot): LessonPdfImageMetadata[] => {
  if (!isRecord(project.documentAssets) || !Array.isArray(project.documentAssets.usedImages)) {
    return [];
  }
  return project.documentAssets.usedImages.flatMap(image => {
    const parsed = LessonPdfImageMetadataSchema.safeParse(image);
    return parsed.success ? [parsed.data] : [];
  });
};

const decodeImageDataUrl = (image: LessonPdfImageAsset): Uint8Array => {
  const prefix = `data:${image.mimeType};base64,`;
  if (!image.dataUrl.startsWith(prefix)) throw new Error('Invalid generated PDF image payload.');
  const bytes = new Uint8Array(Buffer.from(image.dataUrl.slice(prefix.length), 'base64'));
  if (bytes.byteLength === 0) throw new Error('Generated PDF image payload is empty.');
  return bytes;
};

const buildPdfImageByteKey = (contentHash: string, mediaType: string): string =>
  JSON.stringify([contentHash, mediaType]);

const buildPdfImageVersionedAssociationKey = (
  contentHash: string,
  mediaType: string,
  sourceId?: string,
  sourceHash?: string
): string => JSON.stringify([contentHash, mediaType, sourceId ?? null, sourceHash ?? null]);

interface PdfImageStageState {
  readonly context: LessonGenerationStageContext<LessonCoverageState>;
  readonly dependencies: Pick<LessonDocumentSourceStageDependencies, 'assets' | 'captionImage'>;
  readonly metadataByAssociation: Map<string, LessonPdfImageMetadata>;
  readonly reusableAssetsByByteKey: Map<string, LessonPdfImageMetadata['asset']>;
}

const stagePdfImageBytes = async (
  image: LessonPdfImageAsset,
  bytes: Uint8Array,
  contentHash: string,
  state: PdfImageStageState
): Promise<LessonPdfImageMetadata['asset']> => {
  const byteKey = buildPdfImageByteKey(contentHash, image.mimeType);
  const existing = state.reusableAssetsByByteKey.get(byteKey);
  if (existing) return existing;
  const asset = await state.dependencies.assets.stage({
    bytes,
    idempotencyKey: JSON.stringify([
      'lesson-pdf-image',
      state.context.idempotencyKey,
      contentHash,
      image.mimeType,
    ]),
    mediaType: image.mimeType,
    nodeInstanceId: state.context.execution.nodeInstanceId,
    projectId: state.context.input.request.projectId,
    runId: state.context.execution.runId,
    signal: state.context.signal,
    userId: state.context.input.request.userId,
  });
  state.reusableAssetsByByteKey.set(byteKey, asset);
  return asset;
};

const toPdfImageMetadata = (
  image: LessonPdfImageAsset,
  asset: LessonPdfImageMetadata['asset'],
  caption: string | null = image.caption || null
): LessonPdfImageMetadata => ({
  asset,
  ...(caption ? { caption } : {}),
  id: image.id,
  ...(image.intrinsicHeight ? { intrinsicHeight: image.intrinsicHeight } : {}),
  ...(image.intrinsicWidth ? { intrinsicWidth: image.intrinsicWidth } : {}),
  ...(image.pageNumber ? { pageNumber: image.pageNumber } : {}),
  ...(image.sourceHash ? { sourceHash: image.sourceHash } : {}),
  ...(image.sourceId ? { sourceId: image.sourceId } : {}),
  sourceOrder: image.sourceOrder,
  textAfter: image.textAfter,
  textBefore: image.textBefore,
  ...(image.textCurrent ? { textCurrent: image.textCurrent } : {}),
});

const stageLegacyPdfImage = async (
  image: LessonPdfImageAsset,
  state: PdfImageStageState
): Promise<LessonPdfImageMetadata> => {
  const bytes = decodeImageDataUrl(image);
  const contentHash = buildSha256HexDigest(bytes);
  const associationKey = buildPdfImageVersionedAssociationKey(
    contentHash,
    image.mimeType,
    image.sourceId,
    image.sourceHash
  );
  const existing = state.metadataByAssociation.get(associationKey);
  if (existing) return existing;
  const metadata = toPdfImageMetadata(
    image,
    await stagePdfImageBytes(image, bytes, contentHash, state)
  );
  state.metadataByAssociation.set(associationKey, metadata);
  return metadata;
};

const stageExtractedPdfImage = async (
  image: LessonPdfImageAsset,
  state: PdfImageStageState
): Promise<LessonPdfImageMetadata> => {
  const bytes = decodeImageDataUrl(image);
  const contentHash = buildSha256HexDigest(bytes);
  const associationKey = buildPdfImageVersionedAssociationKey(
    contentHash,
    image.mimeType,
    image.sourceId,
    image.sourceHash
  );
  const existing = state.metadataByAssociation.get(associationKey);
  if (existing) return existing;
  const asset = await stagePdfImageBytes(image, bytes, contentHash, state);
  let caption: string | null = null;
  try {
    caption = await state.dependencies.captionImage({ context: state.context, image });
  } catch (error) {
    if (state.context.signal.aborted) throw error;
    console.warn('[Lesson workflow] Optional PDF image caption failed.', {
      error,
      pageNumber: image.pageNumber,
      projectId: state.context.input.request.projectId,
    });
  }
  const metadata = toPdfImageMetadata(image, asset, caption);
  state.metadataByAssociation.set(associationKey, metadata);
  return metadata;
};

const stageExtractedPdfImages = async (
  images: LessonPdfImageAsset[],
  state: PdfImageStageState
): Promise<LessonPdfImageMetadata[]> => {
  const imagesBySource = new Map<string | undefined, LessonPdfImageAsset[]>();
  for (const image of images) {
    const sourceImages = imagesBySource.get(image.sourceId) ?? [];
    sourceImages.push(image);
    imagesBySource.set(image.sourceId, sourceImages);
  }
  const staged: LessonPdfImageMetadata[] = [];
  for (const sourceImages of imagesBySource.values()) {
    staged.push(
      ...(await Promise.all(sourceImages.map(image => stageExtractedPdfImage(image, state))))
    );
  }
  return staged;
};

const toImageCandidate = (
  image: LessonPdfImageMetadata,
  sectionTitle: string,
  sectionDescription: string
) => ({
  ...(image.caption ? { caption: image.caption } : {}),
  id: image.id,
  ...(image.intrinsicHeight ? { intrinsicHeight: image.intrinsicHeight } : {}),
  ...(image.intrinsicWidth ? { intrinsicWidth: image.intrinsicWidth } : {}),
  ...(image.pageNumber ? { pageNumber: image.pageNumber } : {}),
  sizeBytes: image.asset.byteSize,
  sourceOrder: image.sourceOrder,
  textAfter: image.textAfter,
  textBefore: image.textBefore,
  ...(image.textCurrent ? { textCurrent: image.textCurrent } : {}),
  visibleLabel: buildVisibleImageLabel(image, sectionTitle, sectionDescription),
});

const hasMultipleProjectSources = (project: ProjectSnapshot): boolean =>
  isRecord(project.source) &&
  Array.isArray(project.source.sources) &&
  project.source.sources.length > 1;

const selectSectionPdfImages = (
  images: LessonPdfImageMetadata[],
  project: ProjectSnapshot,
  section: Record<string, unknown>
): LessonPdfImageMetadata[] => {
  if (!hasMultipleProjectSources(project)) return images;
  const selectedSourceIds = readSectionSourceIds(project, section);
  return images.filter(
    image =>
      image.sourceId && (selectedSourceIds.size === 0 || selectedSourceIds.has(image.sourceId))
  );
};

const readCurrentProjectSourceHashes = (project: ProjectSnapshot): Map<string, string> => {
  const hashes = new Map<string, string>();
  if (!isRecord(project.source)) return hashes;
  const addHash = (sourceId: unknown, sourceHash: unknown) => {
    if (typeof sourceId !== 'string' || !sourceId.trim()) return;
    const parsed = Sha256HexSchema.safeParse(sourceHash);
    if (parsed.success) hashes.set(sourceId, parsed.data);
  };
  if (Array.isArray(project.source.sources)) {
    for (const source of project.source.sources) {
      if (isRecord(source)) addHash(source.id, source.hash);
    }
  }
  if (isRecord(project.source.ref)) {
    let primarySourceId: unknown = project.source.ref.id;
    if (typeof primarySourceId !== 'string' && isRecord(project.source.file)) {
      primarySourceId = project.source.file.sourceId;
    }
    addHash(primarySourceId, project.source.ref.hash);
  }
  return hashes;
};

const belongsToCurrentSourceVersion = (
  image: LessonPdfImageMetadata,
  currentSourceHashes: ReadonlyMap<string, string>
): boolean => {
  if (!image.sourceId) return true;
  const currentSourceHash = currentSourceHashes.get(image.sourceId);
  return !currentSourceHash || image.sourceHash === currentSourceHash;
};

export const createLessonDocumentSourceStage =
  (dependencies: LessonDocumentSourceStageDependencies) =>
  async (
    context: LessonGenerationStageContext<LessonCoverageState>
  ): Promise<LessonSourcesState> => {
    const { projectId, sectionId, userId } = context.input.request;
    const project = await dependencies.loadProject(userId, projectId);
    if (!project) {
      throw failPermanently({
        code: 'lesson_project_missing',
        message: 'The lesson project no longer exists.',
      });
    }
    const section = findProjectLessonSection(project, sectionId);
    if (!section) {
      throw failPermanently({
        code: 'lesson_target_missing',
        message: 'The lesson target no longer exists.',
      });
    }
    if (
      buildLessonGenerationSourceFingerprint(project, sectionId) !== context.input.sourceFingerprint
    ) {
      throw failPermanently({
        code: 'lesson_source_authority_changed',
        message: 'The lesson sources changed during generation.',
      });
    }

    const durable = readDurablePdfImages(project);
    const durableIds = new Set(durable.map(image => image.id));
    const durableAssetIds = new Set(durable.map(image => image.asset.id));
    const legacy = readExistingPdfImageAssets(project).filter(image => !durableIds.has(image.id));
    const legacyIds = new Set(legacy.map(image => image.id));
    if (!context.providerEffect) throw new Error('Provider effect persistence is required.');
    const extraction = await context.providerEffect.run({
      key: 'extract-images',
      operation: async () => {
        const transient = LessonPdfImageExtractionOutcomeSchema.parse(
          await dependencies.extractImages({ context, project, section })
        );
        const extracted = transient.assets.filter(
          image => !durableIds.has(image.id) && !legacyIds.has(image.id)
        );
        const reusableAssetsByByteKey = new Map(
          durable.map(
            image =>
              [buildPdfImageByteKey(image.asset.hash, image.asset.mediaType), image.asset] as const
          )
        );
        const metadataByAssociation = new Map(
          durable.map(
            image =>
              [
                buildPdfImageVersionedAssociationKey(
                  image.asset.hash,
                  image.asset.mediaType,
                  image.sourceId,
                  image.sourceHash
                ),
                image,
              ] as const
          )
        );
        const stageState: PdfImageStageState = {
          context,
          dependencies,
          metadataByAssociation,
          reusableAssetsByByteKey,
        };
        const stagedLegacy = await Promise.all(
          legacy.map(image => stageLegacyPdfImage(image, stageState))
        );
        const stagedExtracted = await stageExtractedPdfImages(extracted, stageState);
        return {
          assets: [...stagedLegacy, ...stagedExtracted],
          warnings: transient.warnings,
        };
      },
      outputSchema: DurableLessonPdfImageExtractionOutcomeSchema,
    });
    const staged = extraction.assets;
    const stagedAssetIds = [
      ...new Set(
        staged.map(image => image.asset.id).filter(assetId => !durableAssetIds.has(assetId))
      ),
    ];
    const currentSourceHashes = readCurrentProjectSourceHashes(project);
    const availableById = new Map(
      durable
        .filter(image => belongsToCurrentSourceVersion(image, currentSourceHashes))
        .map(image => [image.id, image])
    );
    for (const image of staged) {
      if (!belongsToCurrentSourceVersion(image, currentSourceHashes)) continue;
      availableById.set(image.id, image);
    }
    const available = selectSectionPdfImages([...availableById.values()], project, section);
    const sourceIds = new Set(available.flatMap(image => (image.sourceId ? [image.sourceId] : [])));
    const mappedPagesBySourceId = new Map(
      [...sourceIds].map(sourceId => [
        sourceId,
        readMappedPdfPages(project, section, sourceId) ?? [],
      ])
    );
    const singleSourceMappedPages = hasMultipleProjectSources(project)
      ? []
      : (readMappedPdfPages(project, section) ?? []);
    const candidates = selectCandidatePdfImages(
      available,
      context.input.lessonInputData.sectionTitle,
      context.input.lessonInputData.description,
      image => {
        const scopedPages = image.sourceId ? mappedPagesBySourceId.get(image.sourceId) : undefined;
        return scopedPages?.length ? scopedPages : singleSourceMappedPages;
      }
    );

    return {
      ...context.input,
      documentAssetOwners: stagedAssetIds.length
        ? [
            {
              assetIds: stagedAssetIds,
              nodeInstanceId: context.execution.nodeInstanceId,
            },
          ]
        : [],
      lessonInputData: {
        ...context.input.lessonInputData,
        imageCandidates: candidates.map(image =>
          toImageCandidate(
            image,
            context.input.lessonInputData.sectionTitle,
            context.input.lessonInputData.description
          )
        ),
      },
      pdfImages: available,
      stage: 'sources',
      warnings: [...context.input.warnings, ...extraction.warnings],
    };
  };
