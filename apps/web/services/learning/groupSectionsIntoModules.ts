import type { LearningModule, LearningSection, LessonNode, PathNode } from '../../types.ts';

const UNTITLED = 'Untitled module';

const isCombiningMarkCodePoint = (codePoint: number): boolean =>
  codePoint >= 0x0300 && codePoint <= 0x036f;

const stripCombiningMarks = (input: string): string =>
  Array.from(input)
    .filter(character => {
      const codePoint = character.codePointAt(0);
      return codePoint === undefined || !isCombiningMarkCodePoint(codePoint);
    })
    .join('');

const trimHyphenEdges = (input: string): string => {
  let startIndex = 0;
  let endIndex = input.length;

  while (startIndex < endIndex && input[startIndex] === '-') {
    startIndex += 1;
  }

  while (endIndex > startIndex && input[endIndex - 1] === '-') {
    endIndex -= 1;
  }

  return input.slice(startIndex, endIndex);
};

const slugify = (input: string): string => {
  const normalizedInput = stripCombiningMarks(input.toLowerCase().normalize('NFKD'));
  const collapsedSeparators = normalizedInput.replaceAll(/[^a-z0-9]+/g, '-');
  const trimmedSlug = trimHyphenEdges(collapsedSeparators);
  const base = trimmedSlug.slice(0, 48);
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
