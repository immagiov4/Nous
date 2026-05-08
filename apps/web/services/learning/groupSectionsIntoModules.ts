import type {
  LearningModule,
  LearningSection,
  LessonNode,
  PathNode,
} from '../../types.ts';

const UNTITLED = 'Untitled module';

const slugify = (input: string): string => {
  const base = input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return base.length > 0 ? base : 'untitled';
};

const sectionToLessonNode = (section: LearningSection): LessonNode => {
  const { moduleTitle: _moduleTitle, ...rest } = section;
  return { kind: 'lesson', ...rest };
};

const deriveModuleType = (children: PathNode[]): LearningModule['type'] => {
  const types = new Set<string>();
  for (const child of children) {
    if (child.kind === 'lesson') {
      types.add(child.type);
    }
  }
  if (types.size !== 1) {
    return undefined;
  }
  return [...types][0] as LearningModule['type'];
};

export const groupSectionsIntoModules = (sections: LearningSection[]): LearningModule[] => {
  if (sections.length === 0) {
    return [];
  }

  const modules: LearningModule[] = [];
  let currentTitle: string | null = null;
  let currentChildren: PathNode[] = [];

  const flush = () => {
    if (currentChildren.length === 0) {
      return;
    }
    const title = currentTitle && currentTitle.trim().length > 0 ? currentTitle : UNTITLED;
    const position = modules.length;
    const id = `m-${position}-${slugify(title)}`;
    modules.push({
      id,
      title,
      children: currentChildren,
      type: deriveModuleType(currentChildren),
    });
    currentChildren = [];
  };

  for (let i = 0; i < sections.length; i++) {
    const section = sections[i];
    const sectionTitle = (section.moduleTitle ?? '').trim() || null;
    const isFirst = i === 0;
    if (!isFirst && sectionTitle !== currentTitle) {
      flush();
    }
    currentTitle = sectionTitle;
    currentChildren.push(sectionToLessonNode(section));
  }
  flush();

  return modules;
};
