import type {
  LearningPlan,
  LessonImageRef,
  LessonNode,
  PdfDocumentAssets,
  PdfImageAsset,
  SyllabusItem,
} from '../../types.ts';
import { buildSectionHierarchyInfoById } from '../learning/sectionTree.ts';

export interface SidebarGroup {
  id: string;
  sectionDepthById: Record<string, number>;
  title: string;
  sections: LessonNode[];
}

export const buildSidebarGroups = (
  learningPlan: LearningPlan | null,
  _syllabus: SyllabusItem[]
): SidebarGroup[] => {
  if (!learningPlan || learningPlan.modules.length === 0) {
    return [];
  }

  return learningPlan.modules
    .map((module, index): SidebarGroup | null => {
      const lessons = module.children.filter(
        (child): child is LessonNode => child.kind === 'lesson'
      );
      if (lessons.length === 0) {
        return null;
      }
      const hierarchyInfoById = buildSectionHierarchyInfoById(lessons);
      return {
        id: module.id || `group-${index}`,
        sectionDepthById: Object.fromEntries(
          lessons.map(lesson => [lesson.id, hierarchyInfoById[lesson.id]?.depth ?? 0])
        ),
        title: module.title || `Modulo ${index + 1}`,
        sections: lessons,
      };
    })
    .filter((group): group is SidebarGroup => Boolean(group));
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
