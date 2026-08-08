import type {
  LearningPlan,
  LessonImageRef,
  LessonNode,
  PathNode,
  PdfDocumentAssets,
  PdfDocumentImageAsset,
  SyllabusItem,
} from '../../types.ts';
import { buildSectionHierarchyInfoById } from '../learning/sectionTree.ts';

export interface SidebarGroup {
  id: string;
  sectionDepthById: Record<string, number>;
  title: string;
  sections: PathNode[];
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
      if (module.children.length === 0) {
        return null;
      }
      const hierarchyInfoById = buildSectionHierarchyInfoById(lessons);
      return {
        id: module.id || `group-${index}`,
        sectionDepthById: Object.fromEntries(
          module.children.map(child => [
            child.id,
            child.kind === 'lesson' ? (hierarchyInfoById[child.id]?.depth ?? 0) : 0,
          ])
        ),
        title: module.title || `Modulo ${index + 1}`,
        sections: module.children,
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
): Record<string, PdfDocumentImageAsset> => {
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
