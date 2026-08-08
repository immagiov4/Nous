import type { ProjectStore } from '../projects/types.js';
import {
  type ProjectSourceMaterial,
  readProjectSourceMaterial,
} from '../services/projectSourceText.js';
import type { CoursePreparationState } from './courseGenerationWorkflowContract.js';
import { failPermanently } from './retryPolicy.js';

type CourseSourceDescriptor = CoursePreparationState['context']['sources'][number];
type CourseSourceState = Pick<CoursePreparationState, 'context' | 'projectRevision' | 'request'>;

export interface CourseSourceMaterial extends ProjectSourceMaterial {
  readonly descriptor: CourseSourceDescriptor;
}

type ReadSourceMaterial = typeof readProjectSourceMaterial;

const compareSourceNames = (left: CourseSourceMaterial, right: CourseSourceMaterial): number => {
  const normalizedLeft = left.descriptor.name.normalize('NFKC').toLowerCase();
  const normalizedRight = right.descriptor.name.normalize('NFKC').toLowerCase();
  if (normalizedLeft !== normalizedRight) return normalizedLeft < normalizedRight ? -1 : 1;
  return left.descriptor.name.localeCompare(right.descriptor.name);
};

export const sortCourseSourceMaterials = (
  materials: readonly CourseSourceMaterial[]
): CourseSourceMaterial[] => [...materials].sort(compareSourceNames);

const sampleSourceText = (text: string, maxChars: number): string => {
  if (maxChars <= 0) return '';
  if (text.length <= maxChars) return text;
  const separator = '\n\n[…]\n\n';
  if (maxChars <= separator.length * 2 + 3) return text.slice(0, maxChars);
  const availableChars = maxChars - separator.length * 2;
  const partChars = Math.floor(availableChars / 3);
  const finalPartChars = availableChars - partChars * 2;
  const middleStart = Math.floor((text.length - partChars) / 2);
  return [
    text.slice(0, partChars),
    text.slice(middleStart, middleStart + partChars),
    text.slice(-finalPartChars),
  ].join(separator);
};

const formatOutline = (material: CourseSourceMaterial): string => {
  const nodes = material.pdf?.outline ?? [];
  const lines: string[] = [];
  const appendNodes = (entries: typeof nodes): void => {
    for (const entry of entries) {
      const page = entry.page ? ` (pag. ${entry.page})` : '';
      lines.push(`${'  '.repeat(Math.max(0, entry.level - 1))}- ${entry.title}${page}`);
      appendNodes(entry.children);
    }
  };
  appendNodes(nodes);
  return lines.join('\n');
};

export const formatCourseSourceMaterials = (
  materials: readonly CourseSourceMaterial[],
  totalTextChars: number
): string => {
  const sorted = sortCourseSourceMaterials(materials);
  if (sorted.length === 0) return '';
  const baseTextChars = Math.floor(totalTextChars / sorted.length);
  const extraChars = totalTextChars % sorted.length;
  return sorted
    .map((material, index) => {
      const outline = formatOutline(material);
      const excerpt = sampleSourceText(material.text, baseTextChars + (index < extraChars ? 1 : 0));
      const outlineBlock = outline ? `<outline>\n${outline}\n</outline>\n` : '';
      return `<source id="${material.descriptor.id}" name="${material.descriptor.name}">
${outlineBlock}<excerpt>
${excerpt}
</excerpt>
</source>`;
    })
    .join('\n\n');
};

export const createCourseSourceMaterialReader =
  ({
    loadProjectSources,
    loadProjectWithRevision,
    readSourceMaterial = readProjectSourceMaterial,
  }: {
    readonly loadProjectSources: ProjectStore['loadProjectSources'];
    readonly loadProjectWithRevision: ProjectStore['loadProjectWithRevision'];
    readonly readSourceMaterial?: ReadSourceMaterial;
  }) =>
  async (state: CourseSourceState, signal?: AbortSignal): Promise<CourseSourceMaterial[]> => {
    signal?.throwIfAborted();
    const project = await loadProjectWithRevision(state.request.userId, state.request.projectId);
    if (project?.revision !== state.projectRevision) {
      throw failPermanently({
        code: 'course_source_changed',
        message: 'The course source changed after generation started.',
      });
    }

    const storedSources = await loadProjectSources(state.request.userId, state.request.projectId);
    const storedById = new Map(storedSources.map(source => [source.ref.id, source]));
    const materials: CourseSourceMaterial[] = [];
    for (const descriptor of state.context.sources) {
      signal?.throwIfAborted();
      const stored = storedById.get(descriptor.id);
      if (stored?.ref.hash !== descriptor.hash) {
        throw failPermanently({
          code: 'course_source_changed',
          message: 'The course source changed after generation started.',
        });
      }
      const material = await readSourceMaterial(stored.file);
      signal?.throwIfAborted();
      if (!material.text.trim()) {
        throw failPermanently({
          code: 'course_source_text_missing',
          message: 'The course source does not contain readable text.',
        });
      }
      materials.push({ ...material, descriptor });
    }
    return materials;
  };
