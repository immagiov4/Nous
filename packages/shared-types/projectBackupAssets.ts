import {
  buildLearningArtifactId,
  isLearningArtifactKind,
  LEARNING_ARTIFACT_ID_SEPARATOR,
  type LearningArtifactKind,
} from './learningArtifact';
import {
  buildProjectAssetPlaceholder,
  isProjectAssetId,
  isValidProjectAssetRef,
  type ProjectAssetRef,
  projectAssetRefsMatch,
  validateProjectAssetHtmlReferences,
} from './projectAsset';

const PROJECT_ASSET_IMPORT_ID_VERSION = 'project-asset-import-v1';

export class InvalidProjectBackupAssetError extends Error {
  constructor() {
    super('Project backup contains invalid asset references.');
    this.name = 'InvalidProjectBackupAssetError';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isUnambiguousArtifactScopeId = (value: unknown): value is string =>
  typeof value === 'string' &&
  Boolean(value.trim()) &&
  !value.includes(LEARNING_ARTIFACT_ID_SEPARATOR);

const readAssetRef = (value: unknown): ProjectAssetRef => {
  if (!isValidProjectAssetRef(value)) {
    throw new InvalidProjectBackupAssetError();
  }
  return {
    byteSize: value.byteSize,
    hash: value.hash,
    id: value.id,
    mediaType: value.mediaType,
  };
};

const collectRenderRefs = (visual: unknown): ProjectAssetRef[] => {
  if (!isRecord(visual) || visual.render === undefined) return [];
  if (!isRecord(visual.render)) throw new InvalidProjectBackupAssetError();
  if (visual.render.kind === 'image') return [readAssetRef(visual.render.asset)];
  if (visual.render.kind === 'html') {
    if (typeof visual.render.code !== 'string' || !Array.isArray(visual.render.embeddedAssets)) {
      throw new InvalidProjectBackupAssetError();
    }
    const refs = visual.render.embeddedAssets.map(readAssetRef);
    if (!validateProjectAssetHtmlReferences(visual.render.code, refs).valid) {
      throw new InvalidProjectBackupAssetError();
    }
    return refs;
  }
  if (visual.render.kind === 'mermaid' || visual.render.kind === 'svg') return [];
  throw new InvalidProjectBackupAssetError();
};

const readProjectSections = (project: Record<string, unknown>): Record<string, unknown>[] => {
  if (!isRecord(project.learningPlan)) return [];
  const directSections = Array.isArray(project.learningPlan.sections)
    ? project.learningPlan.sections.filter(isRecord)
    : [];
  const moduleSections = Array.isArray(project.learningPlan.modules)
    ? project.learningPlan.modules
        .filter(isRecord)
        .flatMap(module => (Array.isArray(module.children) ? module.children.filter(isRecord) : []))
    : [];
  return [...moduleSections, ...directSections];
};

const collectStructuredPdfRefs = (project: Record<string, unknown>): ProjectAssetRef[] => {
  if (!isRecord(project.documentAssets) || !Array.isArray(project.documentAssets.usedImages)) {
    return [];
  }
  return project.documentAssets.usedImages.flatMap(image =>
    isRecord(image) && image.asset !== undefined ? [readAssetRef(image.asset)] : []
  );
};

export const collectProjectAssetReferences = (project: unknown): readonly ProjectAssetRef[] => {
  if (!isRecord(project)) throw new InvalidProjectBackupAssetError();
  const refs = [
    ...readProjectSections(project).flatMap(section =>
      Array.isArray(section.generatedVisuals)
        ? section.generatedVisuals.flatMap(collectRenderRefs)
        : []
    ),
    ...collectStructuredPdfRefs(project),
  ];
  const refsById = new Map<string, ProjectAssetRef>();
  for (const ref of refs) {
    const existing = refsById.get(ref.id);
    if (existing && !projectAssetRefsMatch(existing, ref)) {
      throw new InvalidProjectBackupAssetError();
    }
    refsById.set(ref.id, ref);
  }
  return Object.freeze(
    [...refsById.values()].sort((left, right) => left.id.localeCompare(right.id))
  );
};

const readReplacementId = (idMap: ReadonlyMap<string, string>, sourceId: string): string => {
  const replacement = idMap.get(sourceId);
  if (!isProjectAssetId(replacement)) {
    throw new InvalidProjectBackupAssetError();
  }
  return replacement;
};

const remapRef = (value: unknown, idMap: ReadonlyMap<string, string>): ProjectAssetRef => {
  const ref = readAssetRef(value);
  return { ...ref, id: readReplacementId(idMap, ref.id) };
};

const remapVisual = (visual: Record<string, unknown>, idMap: ReadonlyMap<string, string>): void => {
  if (visual.render === undefined) return;
  if (!isRecord(visual.render)) throw new InvalidProjectBackupAssetError();
  if (visual.render.kind === 'image') {
    visual.render.asset = remapRef(visual.render.asset, idMap);
    return;
  }
  if (visual.render.kind === 'html') {
    const sourceRefs = collectRenderRefs(visual);
    if (typeof visual.render.code !== 'string') throw new InvalidProjectBackupAssetError();
    let code = visual.render.code;
    for (const sourceRef of sourceRefs) {
      const replacementId = readReplacementId(idMap, sourceRef.id);
      code = code
        .split(buildProjectAssetPlaceholder(sourceRef.id))
        .join(buildProjectAssetPlaceholder(replacementId));
    }
    visual.render.code = code;
    visual.render.embeddedAssets = sourceRefs.map(ref => remapRef(ref, idMap));
    collectRenderRefs(visual);
    return;
  }
  if (visual.render.kind !== 'mermaid' && visual.render.kind !== 'svg') {
    throw new InvalidProjectBackupAssetError();
  }
};

const remapDocumentAssetReferences = (
  project: Record<string, unknown>,
  idMap: ReadonlyMap<string, string>
): void => {
  if (!isRecord(project.documentAssets) || !Array.isArray(project.documentAssets.usedImages)) {
    return;
  }
  for (const image of project.documentAssets.usedImages) {
    if (isRecord(image) && image.asset !== undefined) {
      image.asset = remapRef(image.asset, idMap);
    }
  }
};

const isProjectScopedAnnotationArtifactRef = (
  value: unknown
): value is Record<string, unknown> & {
  artifactId: string;
  kind: LearningArtifactKind;
} => isRecord(value) && typeof value.artifactId === 'string' && isLearningArtifactKind(value.kind);

const addOwnedArtifactId = ({
  artifactId,
  artifactIds,
  kind,
  lessonId,
  sourceProjectId,
  targetProjectId,
}: {
  artifactId: string;
  artifactIds: Map<string, string>;
  kind: LearningArtifactKind;
  lessonId: string;
  sourceProjectId: string;
  targetProjectId: string;
}): void => {
  const identity = { artifactId, kind, lessonId };
  artifactIds.set(
    buildLearningArtifactId({ ...identity, projectId: sourceProjectId }),
    buildLearningArtifactId({ ...identity, projectId: targetProjectId })
  );
};

const buildOwnedAnnotationArtifactIdMap = (
  project: Record<string, unknown>,
  sourceProjectId: string,
  targetProjectId: string
): ReadonlyMap<string, string> => {
  const artifactIds = new Map<string, string>();
  const pdfImageIds = new Set(
    isRecord(project.documentAssets) && Array.isArray(project.documentAssets.usedImages)
      ? project.documentAssets.usedImages.flatMap(image =>
          isRecord(image) && typeof image.id === 'string' ? [image.id] : []
        )
      : []
  );
  for (const section of readProjectSections(project)) {
    if (typeof section.id !== 'string') continue;
    if (!isUnambiguousArtifactScopeId(section.id)) {
      throw new InvalidProjectBackupAssetError();
    }
    if (Array.isArray(section.generatedVisuals)) {
      for (const visual of section.generatedVisuals) {
        if (!isRecord(visual) || typeof visual.id !== 'string') continue;
        addOwnedArtifactId({
          artifactId: visual.id,
          artifactIds,
          kind: 'generated-visual',
          lessonId: section.id,
          sourceProjectId,
          targetProjectId,
        });
      }
    }
    if (Array.isArray(section.imageRefs)) {
      for (const imageRef of section.imageRefs) {
        if (
          !isRecord(imageRef) ||
          typeof imageRef.assetId !== 'string' ||
          !pdfImageIds.has(imageRef.assetId)
        ) {
          continue;
        }
        addOwnedArtifactId({
          artifactId: imageRef.assetId,
          artifactIds,
          kind: 'pdf-image',
          lessonId: section.id,
          sourceProjectId,
          targetProjectId,
        });
      }
    }
  }
  return artifactIds;
};

const remapAnnotationArtifactReferences = (
  project: Record<string, unknown>,
  sourceProjectId: string,
  targetProjectId: string
): void => {
  const sections = readProjectSections(project);
  const artifactIds = buildOwnedAnnotationArtifactIdMap(project, sourceProjectId, targetProjectId);
  for (const section of sections) {
    if (!Array.isArray(section.annotations)) continue;
    for (const annotation of section.annotations) {
      if (!isRecord(annotation) || !Array.isArray(annotation.artifactRefs)) continue;
      for (const artifactRef of annotation.artifactRefs) {
        if (!isProjectScopedAnnotationArtifactRef(artifactRef)) continue;
        artifactRef.artifactId = artifactIds.get(artifactRef.artifactId) ?? artifactRef.artifactId;
      }
    }
  }
};

export const remapProjectAssetReferences = <T>(
  project: T,
  idMap: ReadonlyMap<string, string>,
  targetProjectId?: string
): T => {
  collectProjectAssetReferences(project);
  const remapped = structuredClone(project);
  if (!isRecord(remapped)) throw new InvalidProjectBackupAssetError();
  const remappedProject: Record<string, unknown> = remapped;
  if (targetProjectId !== undefined) {
    if (
      !isUnambiguousArtifactScopeId(remappedProject.id) ||
      !isUnambiguousArtifactScopeId(targetProjectId)
    ) {
      throw new InvalidProjectBackupAssetError();
    }
    remapAnnotationArtifactReferences(remappedProject, remappedProject.id, targetProjectId);
    remappedProject.id = targetProjectId;
  }
  for (const section of readProjectSections(remappedProject)) {
    if (!Array.isArray(section.generatedVisuals)) continue;
    for (const visual of section.generatedVisuals) {
      if (!isRecord(visual)) continue;
      remapVisual(visual, idMap);
    }
  }
  remapDocumentAssetReferences(remappedProject, idMap);
  collectProjectAssetReferences(remappedProject);
  return remapped as T;
};

const sha256 = async (value: string): Promise<string> => {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
};

export const buildImportedProjectAssetIdentity = async (input: {
  contentHash: string;
  projectId: string;
  sourceAssetId: string;
  userId: string;
}): Promise<{ id: string; objectPath: string }> => {
  if (
    !isProjectAssetId(input.contentHash) ||
    !isProjectAssetId(input.sourceAssetId) ||
    !input.projectId.trim() ||
    !input.userId.trim()
  ) {
    throw new InvalidProjectBackupAssetError();
  }
  const id = await sha256(
    JSON.stringify([
      PROJECT_ASSET_IMPORT_ID_VERSION,
      input.userId.trim(),
      input.projectId.trim(),
      input.sourceAssetId,
      input.contentHash,
    ])
  );
  return {
    id,
    objectPath: [
      'users',
      input.userId.trim(),
      'projects',
      await sha256(input.projectId.trim()),
      'assets',
      'archive',
      id,
      input.contentHash,
    ].join('/'),
  };
};
