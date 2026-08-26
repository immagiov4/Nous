import { buildLearningArtifactId } from '@shared/learningArtifact';

import { groupSectionsIntoModules } from '../../services/learning/groupSectionsIntoModules.ts';
import type {
  LearningArtifactRenderPayload,
  LearningArtifactSummary,
  LearningSection,
  LessonImageRef,
  PdfDocumentAssets,
  PdfDocumentImageAsset,
  ProjectSnapshot,
  StoredLessonVisual,
} from '../../types.ts';
import { getStoredLessonVisualKind } from '../visuals/storedLessonVisual.ts';
import { flattenLessons } from './pathNodes.ts';

interface CollectLearningArtifactPayloadsInput {
  projectTitle?: string;
  snapshot: ProjectSnapshot;
}

interface FilterLearningArtifactPayloadsOptions {
  artifactIds?: string[];
  kinds?: LearningArtifactSummary['kind'][];
  lessonIds?: string[];
  lessonQuery?: string;
  maxResults?: number;
  projectIds?: string[];
  query?: string;
}

const PDF_IMAGE_PLACEHOLDER_REGEX = /\{\{PDF_IMAGE:([^|}]+)(?:\|[^}]*)?\}\}/g;
const VISUAL_EXAMPLE_PLACEHOLDER_REGEX = /\{\{VISUAL_EXAMPLE:([^|}]+)(?:\|[^}]*)?\}\}/g;
const DEFAULT_MAX_ARTIFACT_RESULTS = 24;
const GENERATED_VISUAL_FALLBACK_ORDER = 1_000_000;
const GENERATED_VISUAL_ARTIFACT_SEGMENT = ':generated-visual:';

const normalizeSearchText = (value: string): string =>
  value
    .toLowerCase()
    .normalize('NFD')
    .replaceAll(/[\u0300-\u036f]/g, '')
    .replaceAll(/[^\p{L}\p{N}\s]/gu, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim();

const formatGeneratedVisualTitle = (title?: string): string =>
  title?.replaceAll(/[_-]+/g, ' ').replaceAll(/\s+/g, ' ').trim() || 'Esempio visuale';

export const getGeneratedVisualSourceLabel = (visual: StoredLessonVisual): string => {
  const kind = getStoredLessonVisualKind(visual);
  if (kind === 'image') {
    return 'Immagine';
  }

  return kind === 'html' ? 'Interattivo' : 'Visuale';
};

export const readGeneratedVisualIdFromArtifactId = (artifactId: string): string => {
  const segmentIndex = artifactId.indexOf(GENERATED_VISUAL_ARTIFACT_SEGMENT);
  return segmentIndex >= 0
    ? artifactId.slice(segmentIndex + GENERATED_VISUAL_ARTIFACT_SEGMENT.length)
    : artifactId;
};

export const resolveGeneratedVisualArtifact = (
  artifactId: string,
  visualsById?: Readonly<Record<string, StoredLessonVisual>>
): StoredLessonVisual | undefined => {
  const exactMatch = visualsById?.[artifactId];
  if (exactMatch || !visualsById) return exactMatch;

  let matchedVisual: StoredLessonVisual | undefined;
  for (const [visualId, visual] of Object.entries(visualsById)) {
    if (!artifactId.endsWith(`${GENERATED_VISUAL_ARTIFACT_SEGMENT}${visualId}`)) continue;
    if (matchedVisual) return undefined;
    matchedVisual = visual;
  }
  return matchedVisual;
};

export const replaceGeneratedVisualPreservingId = ({
  artifactId,
  replacementVisual,
  visuals,
}: {
  artifactId: string;
  replacementVisual: StoredLessonVisual;
  visuals?: StoredLessonVisual[];
}): StoredLessonVisual[] | null => {
  const targetVisualId = readGeneratedVisualIdFromArtifactId(artifactId);
  let didReplace = false;
  const nextVisuals = (visuals || []).map(visual => {
    if (visual.id !== targetVisualId) {
      return visual;
    }

    didReplace = true;
    return {
      ...replacementVisual,
      id: visual.id,
    };
  });

  return didReplace ? nextVisuals : null;
};

const readPlaceholderOrder = (content: string) => {
  const orderByKey = new Map<string, number>();
  PDF_IMAGE_PLACEHOLDER_REGEX.lastIndex = 0;
  VISUAL_EXAMPLE_PLACEHOLDER_REGEX.lastIndex = 0;

  for (const match of content.matchAll(PDF_IMAGE_PLACEHOLDER_REGEX)) {
    orderByKey.set(`pdf-image:${match[1]}`, match.index ?? Number.MAX_SAFE_INTEGER);
  }

  for (const match of content.matchAll(VISUAL_EXAMPLE_PLACEHOLDER_REGEX)) {
    orderByKey.set(`generated-visual:${match[1]}`, match.index ?? Number.MAX_SAFE_INTEGER);
  }

  return orderByKey;
};

const getPdfImageTitle = (imageRef: LessonImageRef, asset: PdfDocumentImageAsset): string =>
  imageRef.caption?.trim() ||
  imageRef.alt?.trim() ||
  asset.caption?.trim() ||
  asset.textCurrent?.trim() ||
  'Figura PDF';

const getSectionSearchText = (lesson: LearningSection): string =>
  [lesson.title, lesson.description, lesson.content].filter(Boolean).join(' ');

const buildPdfImagePayload = ({
  asset,
  imageRef,
  lesson,
  projectId,
  projectTitle,
}: {
  asset: PdfDocumentImageAsset;
  imageRef: LessonImageRef;
  lesson: LearningSection;
  projectId: string;
  projectTitle: string;
}): LearningArtifactRenderPayload => ({
  image: asset,
  searchText: [
    getSectionSearchText(lesson),
    imageRef.alt,
    imageRef.caption,
    asset.caption,
    asset.textBefore,
    asset.textCurrent,
    asset.textAfter,
  ]
    .filter(Boolean)
    .join(' '),
  summary: {
    id: buildLearningArtifactId({
      artifactId: asset.id,
      kind: 'pdf-image',
      lessonId: lesson.id,
      projectId,
    }),
    kind: 'pdf-image',
    lessonId: lesson.id,
    lessonTitle: lesson.title,
    previewMode: 'thumbnail',
    projectId,
    projectTitle,
    sourceLabel: asset.pageNumber ? `Pagina ${asset.pageNumber}` : undefined,
    title: getPdfImageTitle(imageRef, asset),
    description: asset.caption || imageRef.alt || lesson.description,
  },
});

const getVisualPreviewMode = (
  visual: StoredLessonVisual
): LearningArtifactSummary['previewMode'] =>
  getStoredLessonVisualKind(visual) === 'html' ? 'chip-only' : 'thumbnail';

export const buildGeneratedVisualLearningArtifactPayload = ({
  lesson,
  projectId,
  projectTitle,
  visual,
}: {
  lesson: LearningSection;
  projectId: string;
  projectTitle: string;
  visual: StoredLessonVisual;
}): LearningArtifactRenderPayload => ({
  searchText: [getSectionSearchText(lesson), visual.title, visual.altText, visual.anchorHeading]
    .filter(Boolean)
    .join(' '),
  summary: {
    createdAt: visual.createdAt,
    id: buildLearningArtifactId({
      artifactId: visual.id,
      kind: 'generated-visual',
      lessonId: lesson.id,
      projectId,
    }),
    kind: 'generated-visual',
    lessonId: lesson.id,
    lessonTitle: lesson.title,
    previewMode: getVisualPreviewMode(visual),
    projectId,
    projectTitle,
    sourceLabel: getGeneratedVisualSourceLabel(visual),
    title: formatGeneratedVisualTitle(visual.title),
    description: lesson.description,
  },
  visual,
});

const buildImageAssetMap = (documentAssets: PdfDocumentAssets | null | undefined) =>
  new Map((documentAssets?.usedImages || []).map(asset => [asset.id, asset]));

const getArtifactSearchText = (artifact: LearningArtifactRenderPayload): string => {
  const { summary } = artifact;
  const baseText = [
    artifact.searchText,
    summary.title,
    summary.description,
    summary.lessonTitle,
    summary.projectTitle,
    summary.sourceLabel,
  ];

  if ('image' in artifact) {
    baseText.push(
      artifact.image.caption,
      artifact.image.textBefore,
      artifact.image.textCurrent,
      artifact.image.textAfter
    );
  }

  if ('visual' in artifact) {
    baseText.push(artifact.visual.title, artifact.visual.altText, artifact.visual.anchorHeading);
  }

  return normalizeSearchText(baseText.filter(Boolean).join(' '));
};

export const collectLearningArtifactPayloads = ({
  projectTitle,
  snapshot,
}: CollectLearningArtifactPayloadsInput): LearningArtifactRenderPayload[] => {
  const learningPlan = snapshot.learningPlan;
  if (!learningPlan) {
    return [];
  }

  const resolvedProjectTitle = projectTitle?.trim() || learningPlan.title || 'Corso';
  const imageAssetById = buildImageAssetMap(snapshot.documentAssets);

  return flattenLessons(learningPlan.modules).flatMap(section => {
    const placeholderOrder = readPlaceholderOrder(section.content || '');
    const imagePayloads = (section.imageRefs || []).flatMap(imageRef => {
      const asset = imageAssetById.get(imageRef.assetId);
      return asset
        ? [
            {
              order:
                placeholderOrder.get(`pdf-image:${asset.id}`) ?? Math.max(asset.sourceOrder, 0),
              payload: buildPdfImagePayload({
                asset,
                imageRef,
                lesson: section,
                projectId: snapshot.id,
                projectTitle: resolvedProjectTitle,
              }),
            },
          ]
        : [];
    });

    const visualPayloads = (section.generatedVisuals || []).map((visual, index) => ({
      order:
        placeholderOrder.get(`generated-visual:${visual.id}`) ??
        GENERATED_VISUAL_FALLBACK_ORDER + index,
      payload: buildGeneratedVisualLearningArtifactPayload({
        lesson: section,
        projectId: snapshot.id,
        projectTitle: resolvedProjectTitle,
        visual,
      }),
    }));

    return [...imagePayloads, ...visualPayloads]
      .sort((left, right) => left.order - right.order)
      .map(item => item.payload);
  });
};

export const filterLearningArtifactPayloads = (
  artifacts: LearningArtifactRenderPayload[],
  options: FilterLearningArtifactPayloadsOptions = {}
): LearningArtifactRenderPayload[] => {
  const allowedProjectIds = options.projectIds?.length ? new Set(options.projectIds) : null;
  const allowedLessonIds = options.lessonIds?.length ? new Set(options.lessonIds) : null;
  const allowedArtifactIds = options.artifactIds?.length ? new Set(options.artifactIds) : null;
  const allowedKinds = options.kinds?.length ? new Set(options.kinds) : null;
  const normalizedQuery = normalizeSearchText(options.query || '');
  const normalizedLessonQuery = normalizeSearchText(options.lessonQuery || '');
  const maxResults =
    typeof options.maxResults === 'number'
      ? Math.max(1, Math.min(DEFAULT_MAX_ARTIFACT_RESULTS, Math.trunc(options.maxResults)))
      : DEFAULT_MAX_ARTIFACT_RESULTS;

  return artifacts
    .filter(artifact => {
      if (allowedProjectIds && !allowedProjectIds.has(artifact.summary.projectId)) {
        return false;
      }

      if (allowedLessonIds && !allowedLessonIds.has(artifact.summary.lessonId)) {
        return false;
      }

      if (allowedArtifactIds && !allowedArtifactIds.has(artifact.summary.id)) {
        return false;
      }

      if (allowedKinds && !allowedKinds.has(artifact.summary.kind)) {
        return false;
      }

      if (
        normalizedLessonQuery &&
        !normalizeSearchText(
          [artifact.summary.lessonTitle, artifact.searchText].filter(Boolean).join(' ')
        ).includes(normalizedLessonQuery)
      ) {
        return false;
      }

      return !normalizedQuery || getArtifactSearchText(artifact).includes(normalizedQuery);
    })
    .slice(0, maxResults);
};

export const summarizeLearningArtifacts = (
  artifacts: LearningArtifactRenderPayload[]
): LearningArtifactSummary[] => artifacts.map(artifact => artifact.summary);

export const collectSectionLearningArtifactPayloads = ({
  documentAssets,
  projectId,
  projectTitle,
  section,
}: {
  documentAssets?: PdfDocumentAssets | null;
  projectId: string;
  projectTitle: string;
  section: LearningSection;
}): LearningArtifactRenderPayload[] =>
  collectLearningArtifactPayloads({
    projectTitle,
    snapshot: {
      id: projectId,
      learningPlan: {
        title: projectTitle,
        summary: '',
        modules: groupSectionsIntoModules([section]),
        applicationExercisePlanningStatus: 'not-run',
      },
      documentAssets: documentAssets ?? null,
    } as ProjectSnapshot,
  });
