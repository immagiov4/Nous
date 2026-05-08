import type { LearningModule, LessonNode, PathNode } from '../../types.ts';

export const flattenPathNodes = (modules: LearningModule[] | null | undefined): PathNode[] =>
  modules ? modules.flatMap(m => m.children) : [];

export const flattenLessons = (modules: LearningModule[] | null | undefined): LessonNode[] =>
  flattenPathNodes(modules).filter((n): n is LessonNode => n.kind === 'lesson');

export const findPathNodeById = (
  modules: LearningModule[] | null | undefined,
  id: string | null | undefined
): PathNode | null => {
  if (!modules || !id) {
    return null;
  }
  for (const module of modules) {
    for (const child of module.children) {
      if (child.id === id) {
        return child;
      }
    }
  }
  return null;
};

export const updateLessons = (
  modules: LearningModule[],
  updater: (lesson: LessonNode) => LessonNode
): LearningModule[] =>
  modules.map(m => ({
    ...m,
    children: m.children.map(c => (c.kind === 'lesson' ? updater(c) : c)),
  }));
