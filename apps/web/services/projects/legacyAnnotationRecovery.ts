import type {
  ProjectPatch,
  ProjectSnapshot,
  ProjectWriteOptions,
  SavedProjectMeta,
  SectionAnnotation,
} from '../../types.ts';
import { flattenLessons } from '../../utils/learning/pathNodes.ts';
import {
  createSectionAnnotationSelector,
  resolveSectionAnnotationSegments,
} from '../../utils/learning/sectionAnnotationAnchors.ts';
import { getMarkdownProtectedRanges, type MarkdownRange } from '../../utils/markdown/codeRanges.ts';
import { isRecord } from '../../utils/records.ts';
import { timestampIso } from '../../utils/time.ts';
import { normalizeStoredProject } from './projectSnapshot.ts';

const LEGACY_DATABASE_NAME = 'lumina-reader-projects';
const LEGACY_SNAPSHOT_STORE = 'project-snapshots';
const RECOVERY_VERSION = 'v4';
const PREVIOUS_RECOVERY_VERSION = 'v3';
const RECOVERY_COMPLETE_VALUE = 'complete';
const LEGACY_MARK_CLOSE = '</mark>';
const LEGACY_MARK_OPEN_REGEX = /^<mark\b[^>]*>/iu;
const LEGACY_MARK_PRESENT_REGEX = /<mark\b/iu;
const LEGACY_ANNOTATION_ID_REGEX = /\bdata-(?:nous|lumina)-annotation-id=(["'])([^"']+)\1/iu;

type LegacySectionAnnotation = Omit<SectionAnnotation, 'anchor'> & {
  anchor?: SectionAnnotation['anchor'] | { kind: 'selection' };
};

type AnnotationRecoveryRepository = {
  loadProject: (projectId: string) => Promise<ProjectSnapshot | null>;
  patchProject: (
    projectId: string,
    patch: ProjectPatch,
    options?: ProjectWriteOptions
  ) => Promise<SavedProjectMeta>;
};

export interface LegacySnapshotStore {
  close: () => void;
  loadProject: (projectId: string) => Promise<unknown>;
}

interface LegacyAnnotationRecoveryArgs {
  isUserActive?: () => boolean;
  migrationStorage?: Pick<Storage, 'getItem' | 'setItem'>;
  projectMetas: SavedProjectMeta[];
  repository: AnnotationRecoveryRepository;
  userId: string;
}

interface LegacyAnnotationStoreRecoveryArgs extends LegacyAnnotationRecoveryArgs {
  legacyStore: LegacySnapshotStore;
}

export interface SectionAnnotationRecoveryPatch {
  annotations: SectionAnnotation[];
  normalizedCount: number;
  recoveredCount: number;
  sectionId: string;
}

export interface LegacyAnnotationRecoveryPlan {
  acknowledgedAnnotations: { sectionId: string; ids: string[] }[];
  patches: SectionAnnotationRecoveryPatch[];
  unresolvedAnnotationCount: number;
}

const getRecoveryStorageKey = (userId: string, version = RECOVERY_VERSION) =>
  `nous:legacy-annotation-recovery:${version}:${userId}`;

const isTextSelector = (
  value: unknown
): value is NonNullable<SectionAnnotation['anchor']> & { kind: 'selection' } => {
  if (!isRecord(value) || value.kind !== 'selection' || !isRecord(value.selector)) {
    return false;
  }

  const selector = value.selector;
  return (
    typeof selector.start === 'number' &&
    typeof selector.end === 'number' &&
    typeof selector.exact === 'string' &&
    typeof selector.prefix === 'string' &&
    typeof selector.suffix === 'string'
  );
};

const isLegacyAnnotation = (value: unknown): value is LegacySectionAnnotation => {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.note !== 'string' ||
    typeof value.createdAt !== 'string' ||
    typeof value.updatedAt !== 'string'
  ) {
    return false;
  }

  if (
    value.artifactRefs !== undefined &&
    (!Array.isArray(value.artifactRefs) ||
      !value.artifactRefs.every(
        reference =>
          isRecord(reference) &&
          typeof reference.artifactId === 'string' &&
          typeof reference.kind === 'string' &&
          (reference.title === undefined || typeof reference.title === 'string')
      ))
  ) {
    return false;
  }

  if (value.anchor === undefined) {
    return true;
  }
  if (!isRecord(value.anchor)) {
    return false;
  }
  if (value.anchor.kind === 'lesson') {
    return true;
  }
  return (
    value.anchor.kind === 'selection' &&
    (value.anchor.selector === undefined || isTextSelector(value.anchor))
  );
};

const findLegacyAnnotationRanges = (content: string, annotationId: string): MarkdownRange[] => {
  const protectedRanges = getMarkdownProtectedRanges(content);
  const ranges: MarkdownRange[] = [];
  const openStack: Array<{ annotationId?: string; contentStart: number }> = [];
  let protectedIndex = 0;
  let index = 0;

  while (index < content.length) {
    const protectedRange = protectedRanges[protectedIndex];
    if (protectedRange && index >= protectedRange.end) {
      protectedIndex += 1;
      continue;
    }
    if (protectedRange && index >= protectedRange.start) {
      index = protectedRange.end;
      continue;
    }

    if (content.startsWith(LEGACY_MARK_CLOSE, index)) {
      const openTag = openStack.pop();
      if (openTag?.annotationId === annotationId && openTag.contentStart < index) {
        ranges.push({ end: index, start: openTag.contentStart });
      }
      index += LEGACY_MARK_CLOSE.length;
      continue;
    }

    const openTagMatch = content.slice(index).match(LEGACY_MARK_OPEN_REGEX);
    if (openTagMatch) {
      const tag = openTagMatch[0];
      openStack.push({
        annotationId: tag.match(LEGACY_ANNOTATION_ID_REGEX)?.[2],
        contentStart: index + tag.length,
      });
      index += tag.length;
      continue;
    }

    index += 1;
  }

  return ranges;
};

interface NormalizedAnnotationResult {
  annotation?: SectionAnnotation;
  changed: boolean;
  understood: boolean;
}

const normalizeLegacyAnnotation = ({
  annotation,
  preserveCurrentSelector,
  sourceContent,
  targetContent,
}: {
  annotation: LegacySectionAnnotation;
  preserveCurrentSelector: boolean;
  sourceContent: string;
  targetContent: string;
}): NormalizedAnnotationResult => {
  if (annotation.anchor?.kind === 'lesson') {
    return { annotation: annotation as SectionAnnotation, changed: false, understood: true };
  }

  if (isTextSelector(annotation.anchor)) {
    const currentAnnotation = annotation as SectionAnnotation;
    const resolvesInTarget =
      targetContent.length > 0 &&
      resolveSectionAnnotationSegments(targetContent, currentAnnotation).length > 0;
    return {
      annotation: preserveCurrentSelector || resolvesInTarget ? currentAnnotation : undefined,
      changed: false,
      understood: preserveCurrentSelector || resolvesInTarget,
    };
  }

  const selector = createSectionAnnotationSelector(
    sourceContent,
    findLegacyAnnotationRanges(sourceContent, annotation.id)
  );
  if (!selector) {
    return {
      annotation: preserveCurrentSelector ? (annotation as SectionAnnotation) : undefined,
      changed: false,
      understood: false,
    };
  }

  const normalizedAnnotation: SectionAnnotation = {
    ...annotation,
    anchor: { kind: 'selection', selector },
  };
  const resolvesInTarget =
    targetContent.length > 0 &&
    resolveSectionAnnotationSegments(targetContent, normalizedAnnotation).length > 0;
  return {
    annotation: resolvesInTarget
      ? normalizedAnnotation
      : preserveCurrentSelector
        ? (annotation as SectionAnnotation)
        : undefined,
    changed: resolvesInTarget,
    understood: resolvesInTarget,
  };
};

const mergeSectionAnnotations = (
  currentAnnotations: SectionAnnotation[],
  legacyAnnotations: SectionAnnotation[]
): { annotations: SectionAnnotation[]; normalizedCount: number; recoveredCount: number } => {
  const mergedAnnotations = [...currentAnnotations];
  const currentIndexById = new Map(
    mergedAnnotations.map((annotation, index) => [annotation.id, index])
  );
  const knownIds = new Set(currentAnnotations.map(annotation => annotation.id));
  const missingAnnotations: SectionAnnotation[] = [];
  let normalizedCount = 0;

  for (const legacyAnnotation of legacyAnnotations) {
    const currentIndex = currentIndexById.get(legacyAnnotation.id);
    if (currentIndex !== undefined) {
      const currentAnnotation = mergedAnnotations[currentIndex];
      if (
        !isTextSelector(currentAnnotation.anchor) &&
        currentAnnotation.anchor?.kind !== 'lesson' &&
        isTextSelector(legacyAnnotation.anchor)
      ) {
        const enrichedAnnotation = {
          ...legacyAnnotation,
          ...currentAnnotation,
          anchor: legacyAnnotation.anchor,
        };
        mergedAnnotations[currentIndex] = enrichedAnnotation;
        normalizedCount += 1;
      }
      continue;
    }
    if (knownIds.has(legacyAnnotation.id)) {
      continue;
    }
    missingAnnotations.push(legacyAnnotation);
    knownIds.add(legacyAnnotation.id);
  }

  if (missingAnnotations.length === 0) {
    return { annotations: mergedAnnotations, normalizedCount, recoveredCount: 0 };
  }

  return {
    annotations: [...mergedAnnotations, ...missingAnnotations].sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt)
    ),
    normalizedCount,
    recoveredCount: missingAnnotations.length,
  };
};

const getSelectionAnchorKey = (annotation: SectionAnnotation): string | undefined => {
  if (!isTextSelector(annotation.anchor)) return undefined;
  const { exact, prefix, suffix } = annotation.anchor.selector;
  return JSON.stringify([exact, prefix, suffix]);
};

const getLegacySelectionKey = (annotation: LegacySectionAnnotation, content: string) => {
  const normalized = normalizeLegacyAnnotation({
    annotation,
    preserveCurrentSelector: true,
    sourceContent: content,
    targetContent: content,
  }).annotation;
  return normalized && getSelectionAnchorKey(normalized);
};

const buildV3RepairAnchors = (
  legacyAnnotations: SectionAnnotation[],
  legacyContent: string,
  currentAnnotationsById: ReadonlyMap<string, SectionAnnotation>
) => {
  const anchors = new Map<string, SectionAnnotation['anchor'] | null>();
  const addAnchor = (key: string | undefined, annotation: SectionAnnotation) => {
    if (key === undefined || !isTextSelector(annotation.anchor)) return;
    const previous = anchors.get(key);
    // A conflict group with divergent surviving anchors has no unambiguous repair destination.
    anchors.set(
      key,
      anchors.has(key) && JSON.stringify(previous) !== JSON.stringify(annotation.anchor)
        ? null
        : annotation.anchor
    );
  };
  for (const current of currentAnnotationsById.values()) {
    addAnchor(getSelectionAnchorKey(current), current);
  }
  for (const legacy of legacyAnnotations) {
    if (!isLegacyAnnotation(legacy)) continue;
    const current = currentAnnotationsById.get(legacy.id);
    if (current) addAnchor(getLegacySelectionKey(legacy, legacyContent), current);
  }
  return anchors;
};

export const buildLegacyAnnotationRecoveryPlan = (
  currentSnapshot: ProjectSnapshot,
  legacySnapshot: ProjectSnapshot,
  {
    recoveredIdsBySection = new Map(),
    onlySelectionConflicts = false,
  }: {
    recoveredIdsBySection?: ReadonlyMap<string, ReadonlySet<string>>;
    onlySelectionConflicts?: boolean;
  } = {}
): LegacyAnnotationRecoveryPlan => {
  const currentLessonsById = new Map(
    flattenLessons(currentSnapshot.learningPlan?.modules).map(lesson => [lesson.id, lesson])
  );
  const patches: SectionAnnotationRecoveryPatch[] = [];
  const acknowledgedAnnotations: LegacyAnnotationRecoveryPlan['acknowledgedAnnotations'] = [];
  const currentIds = new Set(
    [...currentLessonsById.values()].flatMap(lesson =>
      (lesson.annotations || []).filter(isLegacyAnnotation).map(annotation => annotation.id)
    )
  );
  let unresolvedAnnotationCount = 0;

  for (const legacyLesson of flattenLessons(legacySnapshot.learningPlan?.modules)) {
    const recoveredIds = recoveredIdsBySection.get(legacyLesson.id);
    const pendingAnnotations = (legacyLesson.annotations || []).filter(
      annotation => !isLegacyAnnotation(annotation) || !recoveredIds?.has(annotation.id)
    );
    const currentLesson = currentLessonsById.get(legacyLesson.id);
    if (!currentLesson) {
      if (!onlySelectionConflicts) unresolvedAnnotationCount += pendingAnnotations.length;
      continue;
    }

    const parsedCurrentAnnotations = (currentLesson.annotations || []).map(annotation =>
      isLegacyAnnotation(annotation)
        ? normalizeLegacyAnnotation({
            annotation,
            preserveCurrentSelector: true,
            sourceContent: currentLesson.content || '',
            targetContent: currentLesson.content || '',
          })
        : { annotation: undefined, changed: false, understood: false }
    );
    const currentAnnotationsById = new Map(
      parsedCurrentAnnotations.flatMap(result =>
        result.annotation ? [[result.annotation.id, result.annotation] as const] : []
      )
    );
    const repairAnchors = onlySelectionConflicts
      ? buildV3RepairAnchors(
          legacyLesson.annotations || [],
          legacyLesson.content || '',
          currentAnnotationsById
        )
      : new Map<string, SectionAnnotation['anchor'] | null>();
    const parsedLegacyAnnotations = pendingAnnotations
      .map(annotation => {
        if (!isLegacyAnnotation(annotation)) {
          return { annotation: undefined, changed: false, understood: false };
        }
        const currentAnnotation = currentAnnotationsById.get(annotation.id);
        if (onlySelectionConflicts && !currentAnnotation) {
          const key = getLegacySelectionKey(annotation, legacyLesson.content || '');
          const anchor = key === undefined ? undefined : repairAnchors.get(key);
          return {
            annotation: anchor ? { ...annotation, anchor } : undefined,
            changed: Boolean(anchor),
            understood: Boolean(anchor),
          };
        }
        const legacyResult = normalizeLegacyAnnotation({
          annotation,
          preserveCurrentSelector: false,
          sourceContent: legacyLesson.content || '',
          targetContent: currentLesson.content || '',
        });
        if (
          currentAnnotation &&
          (isTextSelector(currentAnnotation.anchor) ||
            currentAnnotation.anchor?.kind === 'lesson' ||
            !legacyResult.understood)
        ) {
          return { annotation: currentAnnotation, changed: false, understood: true };
        }
        return legacyResult;
      })
      .filter(result => {
        if (!onlySelectionConflicts) return true;
        if (!result.annotation || currentIds.has(result.annotation.id)) return false;
        return true;
      });
    unresolvedAnnotationCount += parsedLegacyAnnotations.filter(
      result => !result.understood
    ).length;

    const normalizedCurrentAnnotations = parsedCurrentAnnotations
      .map(result => result.annotation)
      .filter((annotation): annotation is SectionAnnotation => Boolean(annotation));
    if (normalizedCurrentAnnotations.length !== (currentLesson.annotations || []).length) {
      unresolvedAnnotationCount += parsedCurrentAnnotations.filter(
        result => !result.annotation
      ).length;
      unresolvedAnnotationCount += parsedLegacyAnnotations.length;
      continue;
    }

    const merge = mergeSectionAnnotations(
      normalizedCurrentAnnotations,
      parsedLegacyAnnotations
        .map(result => result.annotation)
        .filter((annotation): annotation is SectionAnnotation => Boolean(annotation))
    );
    const normalizedCount =
      parsedCurrentAnnotations.filter(result => result.changed).length + merge.normalizedCount;
    unresolvedAnnotationCount += parsedCurrentAnnotations.filter(result => {
      if (result.understood) {
        return false;
      }
      if (!result.annotation) {
        return true;
      }
      const mergedAnnotation = merge.annotations.find(
        annotation => annotation.id === result.annotation?.id
      );
      return (
        !mergedAnnotation ||
        (mergedAnnotation.anchor?.kind !== 'lesson' && !isTextSelector(mergedAnnotation.anchor))
      );
    }).length;
    if (merge.recoveredCount > 0 || normalizedCount > 0) {
      patches.push({
        annotations: merge.annotations,
        normalizedCount,
        recoveredCount: merge.recoveredCount,
        sectionId: currentLesson.id,
      });
    }
    acknowledgedAnnotations.push({
      sectionId: currentLesson.id,
      ids: [
        ...new Set([
          ...pendingAnnotations
            .filter(isLegacyAnnotation)
            .filter(annotation => currentAnnotationsById.has(annotation.id))
            .map(annotation => annotation.id),
          ...parsedLegacyAnnotations.flatMap(result =>
            result.understood && result.annotation ? [result.annotation.id] : []
          ),
        ]),
      ],
    });
  }

  return { acknowledgedAnnotations, patches, unresolvedAnnotationCount };
};

export const buildLegacyAnnotationRecoveryPatches = (
  currentSnapshot: ProjectSnapshot,
  legacySnapshot: ProjectSnapshot
): SectionAnnotationRecoveryPatch[] =>
  buildLegacyAnnotationRecoveryPlan(currentSnapshot, legacySnapshot).patches;

const assertUserStillActive = (isUserActive: () => boolean) => {
  if (!isUserActive()) {
    throw new Error('Legacy annotation recovery stopped because the active account changed.');
  }
};

export const recoverLegacyAnnotationsFromStore = async ({
  isUserActive = () => true,
  legacyStore,
  migrationStorage,
  projectMetas,
  repository,
  userId,
}: LegacyAnnotationStoreRecoveryArgs): Promise<number> => {
  const storageKey = getRecoveryStorageKey(userId);
  const previousStorageKey = getRecoveryStorageKey(userId, PREVIOUS_RECOVERY_VERSION);
  const onlySelectionConflicts =
    migrationStorage?.getItem(previousStorageKey) === RECOVERY_COMPLETE_VALUE;
  if (migrationStorage?.getItem(storageKey) === RECOVERY_COMPLETE_VALUE) {
    return 0;
  }

  let changedAnnotationCount = 0;
  let unresolvedAnnotationCount = 0;

  for (const projectMeta of projectMetas) {
    assertUserStillActive(isUserActive);
    const legacyData = await legacyStore.loadProject(projectMeta.id);
    if (!legacyData) {
      continue;
    }

    const legacySnapshot = normalizeStoredProject(legacyData);
    if (legacySnapshot.id !== projectMeta.id) {
      unresolvedAnnotationCount += 1;
      continue;
    }

    const legacyLessons = flattenLessons(legacySnapshot.learningPlan?.modules);
    if (!legacyLessons.some(lesson => lesson.annotations?.length)) {
      if (legacyLessons.some(lesson => LEGACY_MARK_PRESENT_REGEX.test(lesson.content || ''))) {
        unresolvedAnnotationCount += 1;
      }
      continue;
    }

    const currentSnapshot = await repository.loadProject(projectMeta.id);
    if (!currentSnapshot) {
      unresolvedAnnotationCount += 1;
      continue;
    }

    const recoveredIdsBySection = new Map<string, Set<string>>();
    // Keep the existing ID ledger so incomplete recoveries retain their acknowledged deletions.
    const sectionStorageKey = (sectionId: string) =>
      `${previousStorageKey}:ids:${JSON.stringify([projectMeta.id, sectionId])}`;
    for (const lesson of legacyLessons) {
      const storedIds = migrationStorage?.getItem(sectionStorageKey(lesson.id));
      const ids: unknown = storedIds ? JSON.parse(storedIds) : [];
      if (!Array.isArray(ids) || !ids.every(id => typeof id === 'string')) {
        throw new Error('Invalid legacy annotation recovery progress.');
      }
      recoveredIdsBySection.set(lesson.id, new Set(ids));
    }
    const recoveryPlan = buildLegacyAnnotationRecoveryPlan(currentSnapshot, legacySnapshot, {
      recoveredIdsBySection,
      onlySelectionConflicts,
    });
    unresolvedAnnotationCount += recoveryPlan.unresolvedAnnotationCount;
    let expectedRevision = projectMeta.revision;
    for (const acknowledged of recoveryPlan.acknowledgedAnnotations) {
      assertUserStillActive(isUserActive);
      const sectionPatch = recoveryPlan.patches.find(
        patch => patch.sectionId === acknowledged.sectionId
      );
      if (sectionPatch) {
        const updatedMeta = await repository.patchProject(
          projectMeta.id,
          {
            section: {
              annotations: sectionPatch.annotations,
              sectionId: sectionPatch.sectionId,
            },
            updatedAt: timestampIso(),
          },
          { expectedRevision }
        );
        expectedRevision = updatedMeta.revision;
        changedAnnotationCount += sectionPatch.recoveredCount + sectionPatch.normalizedCount;
      }
      if (acknowledged.ids.length > 0) {
        const ids = new Set(recoveredIdsBySection.get(acknowledged.sectionId));
        for (const id of acknowledged.ids) ids.add(id);
        // Persist each successful section before another section can fail or the user can delete it.
        migrationStorage?.setItem(
          sectionStorageKey(acknowledged.sectionId),
          JSON.stringify([...ids])
        );
      }
    }
  }

  assertUserStillActive(isUserActive);
  if (unresolvedAnnotationCount === 0) {
    migrationStorage?.setItem(storageKey, RECOVERY_COMPLETE_VALUE);
  }
  return changedAnnotationCount;
};

const requestValue = <T>(request: IDBRequest<T>): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed.'));
  });

const openLegacySnapshotStore = async (
  indexedDbFactory: IDBFactory
): Promise<LegacySnapshotStore | null> =>
  new Promise((resolve, reject) => {
    let abortedDatabaseCreation = false;
    const request = indexedDbFactory.open(LEGACY_DATABASE_NAME);

    request.onupgradeneeded = event => {
      abortedDatabaseCreation = (event as IDBVersionChangeEvent).oldVersion === 0;
      if (abortedDatabaseCreation) {
        request.transaction?.abort();
      }
    };
    request.onerror = () => {
      if (abortedDatabaseCreation) {
        resolve(null);
        return;
      }
      reject(request.error || new Error('Legacy IndexedDB could not be opened.'));
    };
    request.onsuccess = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(LEGACY_SNAPSHOT_STORE)) {
        database.close();
        resolve(null);
        return;
      }

      database.onversionchange = () => database.close();
      resolve({
        close: () => database.close(),
        loadProject: projectId => {
          const transaction = database.transaction(LEGACY_SNAPSHOT_STORE, 'readonly');
          return requestValue(transaction.objectStore(LEGACY_SNAPSHOT_STORE).get(projectId));
        },
      });
    };
  });

export const recoverLegacyAnnotations = async ({
  isUserActive,
  migrationStorage = typeof globalThis.window === 'undefined' ? undefined : globalThis.localStorage,
  projectMetas,
  repository,
  userId,
}: LegacyAnnotationRecoveryArgs): Promise<number> => {
  if (typeof indexedDB === 'undefined' || projectMetas.length === 0) {
    return 0;
  }

  const storageKey = getRecoveryStorageKey(userId);
  if (migrationStorage?.getItem(storageKey) === RECOVERY_COMPLETE_VALUE) {
    return 0;
  }

  const legacyStore = await openLegacySnapshotStore(indexedDB);
  if (!legacyStore) {
    migrationStorage?.setItem(storageKey, RECOVERY_COMPLETE_VALUE);
    return 0;
  }

  try {
    return await recoverLegacyAnnotationsFromStore({
      isUserActive,
      legacyStore,
      migrationStorage,
      projectMetas,
      repository,
      userId,
    });
  } finally {
    legacyStore.close();
  }
};
