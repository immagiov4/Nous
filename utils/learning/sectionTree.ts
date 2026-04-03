import type { LearningSection } from '../../types.ts';

export interface SectionHierarchyInfo {
  depth: number;
  isValid: boolean;
  rootSectionId: string | null;
}

const INVALID_HIERARCHY: SectionHierarchyInfo = {
  depth: 0,
  isValid: false,
  rootSectionId: null,
};

const buildSectionById = (sections: LearningSection[]) =>
  new Map(sections.map(section => [section.id, section]));

const resolveVisualParentId = (
  section: Pick<LearningSection, 'parentId'>,
  sectionById: Map<string, LearningSection>
): string | null => {
  const parentId = section.parentId?.trim();
  return parentId && sectionById.has(parentId) ? parentId : null;
};

export const buildSectionHierarchyInfoById = (
  sections: LearningSection[]
): Record<string, SectionHierarchyInfo> => {
  const sectionById = buildSectionById(sections);
  const cache = new Map<string, SectionHierarchyInfo>();
  const visiting = new Set<string>();

  const resolveSectionInfo = (sectionId: string): SectionHierarchyInfo => {
    const cached = cache.get(sectionId);
    if (cached) {
      return cached;
    }

    const section = sectionById.get(sectionId);
    if (!section) {
      return INVALID_HIERARCHY;
    }

    if (visiting.has(sectionId)) {
      cache.set(sectionId, INVALID_HIERARCHY);
      return INVALID_HIERARCHY;
    }

    visiting.add(sectionId);

    const visualParentId = resolveVisualParentId(section, sectionById);
    const nextInfo = !visualParentId
      ? {
          depth: 0,
          isValid: true,
          rootSectionId: section.id,
        }
      : (() => {
          const parentInfo = resolveSectionInfo(visualParentId);
          return parentInfo.isValid
            ? {
                depth: parentInfo.depth + 1,
                isValid: true,
                rootSectionId: parentInfo.rootSectionId || visualParentId,
              }
            : INVALID_HIERARCHY;
        })();

    visiting.delete(sectionId);
    cache.set(sectionId, nextInfo);
    return nextInfo;
  };

  return Object.fromEntries(sections.map(section => [section.id, resolveSectionInfo(section.id)]));
};

const isVisualDescendantOf = (
  sectionId: string,
  ancestorId: string,
  sectionById: Map<string, LearningSection>
): boolean => {
  if (sectionId === ancestorId) {
    return false;
  }

  const visited = new Set<string>();
  let currentSection = sectionById.get(sectionId);

  while (currentSection) {
    const visualParentId = resolveVisualParentId(currentSection, sectionById);
    if (!visualParentId || visited.has(visualParentId)) {
      return false;
    }

    if (visualParentId === ancestorId) {
      return true;
    }

    visited.add(visualParentId);
    currentSection = sectionById.get(visualParentId);
  }

  return false;
};

export const insertSectionAfterSubtree = (
  sections: LearningSection[],
  anchorSectionId: string,
  nextSection: LearningSection
): LearningSection[] => {
  const anchorIndex = sections.findIndex(section => section.id === anchorSectionId);
  if (anchorIndex < 0) {
    return sections;
  }

  const sectionById = buildSectionById(sections);
  const hierarchyInfoById = buildSectionHierarchyInfoById(sections);
  const anchorDepth = hierarchyInfoById[anchorSectionId]?.depth ?? 0;

  let insertIndex = anchorIndex + 1;

  while (insertIndex < sections.length) {
    const candidate = sections[insertIndex];
    const candidateDepth = hierarchyInfoById[candidate.id]?.depth ?? 0;

    if (candidateDepth <= anchorDepth) {
      break;
    }

    if (!isVisualDescendantOf(candidate.id, anchorSectionId, sectionById)) {
      break;
    }

    insertIndex += 1;
  }

  return [
    ...sections.slice(0, insertIndex),
    nextSection,
    ...sections.slice(insertIndex),
  ];
};
