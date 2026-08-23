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

const stagePdfImageBytes = (
  image: LessonPdfImageAsset,
  context: LessonGenerationStageContext<LessonCoverageState>,
  assets: Pick<ProjectAssetWriter, 'stage'>
): Promise<LessonPdfImageMetadata['asset']> =>
  assets.stage({
    bytes: decodeImageDataUrl(image),
    idempotencyKey: JSON.stringify(['lesson-pdf-image', context.idempotencyKey, image.id]),
    mediaType: image.mimeType,
    nodeInstanceId: context.execution.nodeInstanceId,
    projectId: context.input.request.projectId,
    runId: context.execution.runId,
    signal: context.signal,
    userId: context.input.request.userId,
  });

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
  ...(image.sourceId ? { sourceId: image.sourceId } : {}),
  sourceOrder: image.sourceOrder,
  textAfter: image.textAfter,
  textBefore: image.textBefore,
  ...(image.textCurrent ? { textCurrent: image.textCurrent } : {}),
});

const stageLegacyPdfImage = async (
  image: LessonPdfImageAsset,
  context: LessonGenerationStageContext<LessonCoverageState>,
  assets: Pick<ProjectAssetWriter, 'stage'>
): Promise<LessonPdfImageMetadata> =>
  toPdfImageMetadata(image, await stagePdfImageBytes(image, context, assets));

const stageExtractedPdfImage = async (
  image: LessonPdfImageAsset,
  context: LessonGenerationStageContext<LessonCoverageState>,
  dependencies: Pick<LessonDocumentSourceStageDependencies, 'assets' | 'captionImage'>
): Promise<LessonPdfImageMetadata> => {
  const asset = await stagePdfImageBytes(image, context, dependencies.assets);
  let caption: string | null = null;
  try {
    caption = await dependencies.captionImage({ context, image });
  } catch (error) {
    if (context.signal.aborted) throw error;
    console.warn('[Lesson workflow] Optional PDF image caption failed.', {
      error,
      pageNumber: image.pageNumber,
      projectId: context.input.request.projectId,
    });
  }
  return toPdfImageMetadata(image, asset, caption);
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
        const [stagedLegacy, stagedExtracted] = await Promise.all([
          Promise.all(
            legacy.map(image => stageLegacyPdfImage(image, context, dependencies.assets))
          ),
          Promise.all(extracted.map(image => stageExtractedPdfImage(image, context, dependencies))),
        ]);
        return {
          assets: [...stagedLegacy, ...stagedExtracted],
          warnings: transient.warnings,
        };
      },
      outputSchema: DurableLessonPdfImageExtractionOutcomeSchema,
    });
    const staged = extraction.assets;
    const availableById = new Map([...durable, ...staged].map(image => [image.id, image]));
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
      documentAssetOwners: staged.length
        ? [
            {
              assetIds: staged.map(image => image.asset.id),
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
