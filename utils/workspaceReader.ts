import type {
  LearningPlan,
  LearningSection,
  LessonImageRef,
  PdfDocumentAssets,
  PdfImageAsset,
  SyllabusItem,
} from '../types.ts';
import { buildSectionHierarchyInfoById } from './learningSectionTree.ts';

export interface SidebarGroup {
  id: string;
  sectionDepthById: Record<string, number>;
  title: string;
  sections: LearningSection[];
}

export const buildSidebarGroups = (
  learningPlan: LearningPlan | null,
  syllabus: SyllabusItem[]
): SidebarGroup[] => {
  if (!learningPlan || learningPlan.sections.length === 0) {
    return [];
  }

  const sectionById = new Map(learningPlan.sections.map(section => [section.id, section]));
  const hierarchyInfoById = buildSectionHierarchyInfoById(learningPlan.sections);
  const moduleTitleById = new Map(syllabus.map(module => [module.id, module.title]));
  const moduleIdBySectionId = new Map<string, string>();

  syllabus.forEach(module => {
    (module.children || []).forEach(lesson => {
      moduleIdBySectionId.set(lesson.id, module.id);
    });
  });

  const resolveModuleId = (sectionId: string): string | null => {
    const visited = new Set<string>();
    let currentId: string | undefined = sectionId;

    while (currentId && !visited.has(currentId)) {
      visited.add(currentId);

      const directModuleId = moduleIdBySectionId.get(currentId);
      if (directModuleId) {
        return directModuleId;
      }

      const currentSection = sectionById.get(currentId);
      currentId = currentSection?.parentId;
    }

    return null;
  };

  const groupedSections = new Map<string, LearningSection[]>();
  const fallbackGroupTitleByKey = new Map<string, string>();
  const groupOrder: string[] = syllabus.map(module => module.id);

  const getFallbackGroupTitle = (section: LearningSection): string =>
    section.moduleTitle?.trim() ||
    (section.type === 'prerequisite'
      ? 'Prerequisiti'
      : section.type === 'summary'
        ? 'Sintesi'
        : 'Percorso');

  learningPlan.sections.forEach(section => {
    const resolvedModuleId = resolveModuleId(section.id);
    const rootSectionId = hierarchyInfoById[section.id]?.rootSectionId || null;
    const fallbackAnchorSection = rootSectionId ? sectionById.get(rootSectionId) || section : section;
    const fallbackTitle = getFallbackGroupTitle(fallbackAnchorSection);
    const fallbackGroupKey = `group:${fallbackTitle}`;
    const groupKey = resolvedModuleId || fallbackGroupKey || '__ungrouped__';

    if (!groupedSections.has(groupKey)) {
      groupedSections.set(groupKey, []);
      if (!groupOrder.includes(groupKey)) {
        groupOrder.push(groupKey);
      }
    }

    if (!resolvedModuleId && !fallbackGroupTitleByKey.has(groupKey)) {
      fallbackGroupTitleByKey.set(groupKey, fallbackTitle);
    }

    groupedSections.get(groupKey)?.push(section);
  });

  const groups = groupOrder
    .map((groupKey, index) => {
      const sections = groupedSections.get(groupKey) || [];
      if (sections.length === 0) {
        return null;
      }

      const isUngrouped = groupKey === '__ungrouped__';

      return {
        id: isUngrouped ? `group-${index}` : groupKey,
        sectionDepthById: Object.fromEntries(
          sections.map(section => [section.id, hierarchyInfoById[section.id]?.depth ?? 0])
        ),
        title:
          moduleTitleById.get(groupKey) ||
          fallbackGroupTitleByKey.get(groupKey) ||
          (isUngrouped ? 'Percorso' : `Modulo ${index + 1}`),
        sections,
      };
    })
    .filter((group): group is SidebarGroup => Boolean(group));

  return groups.length > 0
    ? groups
    : [
        {
          id: 'group-0',
          sectionDepthById: Object.fromEntries(
            learningPlan.sections.map(section => [section.id, hierarchyInfoById[section.id]?.depth ?? 0])
          ),
          title: 'Percorso',
          sections: learningPlan.sections,
        },
      ];
};

export const buildLessonImageRefMap = (
  imageRefs?: LessonImageRef[]
): Record<string, LessonImageRef> =>
  Object.fromEntries((imageRefs || []).map(imageRef => [imageRef.assetId, imageRef]));

export const buildLessonAssetMap = (
  imageRefs: LessonImageRef[] | undefined,
  documentAssets: PdfDocumentAssets | null
): Record<string, PdfImageAsset> => {
  if (!documentAssets || !imageRefs?.length) {
    return {};
  }

  const assetIds = new Set(imageRefs.map(imageRef => imageRef.assetId));
  return Object.fromEntries(
    documentAssets.usedImages
      .filter(asset => assetIds.has(asset.id))
      .map(asset => [asset.id, asset])
  );
};
