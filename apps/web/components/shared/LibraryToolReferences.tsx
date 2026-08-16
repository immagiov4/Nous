import { isToolUIPart, type UIMessage } from 'ai';
import { BookOpen, FileText, NotebookPen } from 'lucide-react';
import { translateUiMessage as t } from '../../i18n/uiMessages.ts';
import { isRecord } from '../../utils/records.ts';

export interface LibraryNavigationTarget {
  annotationId?: string;
  hasNote?: boolean;
  kind: 'annotation' | 'lesson' | 'project';
  lessonId?: string;
  lessonTitle?: string;
  projectId: string;
  projectTitle: string;
}

const readString = (record: Record<string, unknown>, key: string) =>
  typeof record[key] === 'string' ? record[key] : undefined;

const getReferenceKind = (
  isInlineAnnotation: string | boolean | undefined,
  lessonId: string | undefined
): LibraryNavigationTarget['kind'] => {
  if (isInlineAnnotation) return 'annotation';
  if (lessonId) return 'lesson';
  return 'project';
};

const readSearchReferences = (output: Record<string, unknown>): LibraryNavigationTarget[] =>
  Array.isArray(output.hits)
    ? output.hits.filter(isRecord).flatMap(hit => {
        const projectId = readString(hit, 'projectId');
        const projectTitle = readString(hit, 'projectTitle');
        if (!projectId || !projectTitle) return [];
        const lessonId = readString(hit, 'lessonId');
        const lessonTitle = readString(hit, 'lessonTitle');
        const annotationId = readString(hit, 'annotationId');
        const isInlineAnnotation = annotationId && readString(hit, 'anchorKind') !== 'lesson';
        const note = readString(hit, 'note');
        return [
          {
            annotationId: isInlineAnnotation ? annotationId : undefined,
            hasNote: isInlineAnnotation ? Boolean(note?.trim()) : undefined,
            kind: getReferenceKind(isInlineAnnotation, lessonId),
            lessonId,
            lessonTitle,
            projectId,
            projectTitle,
          },
        ];
      })
    : [];

const readLessonDetailReferences = (output: Record<string, unknown>): LibraryNavigationTarget[] =>
  Array.isArray(output.lessonsByProject)
    ? output.lessonsByProject.filter(isRecord).flatMap(project => {
        const projectId = readString(project, 'projectId');
        const projectTitle = readString(project, 'projectTitle');
        if (!projectId || !projectTitle || !Array.isArray(project.lessons)) return [];
        return project.lessons.filter(isRecord).flatMap(lesson => {
          const lessonId = readString(lesson, 'id');
          const lessonTitle = readString(lesson, 'title');
          if (!lessonId || !lessonTitle) return [];
          const lessonReference: LibraryNavigationTarget = {
            kind: 'lesson',
            lessonId,
            lessonTitle,
            projectId,
            projectTitle,
          };
          const annotationReferences = Array.isArray(lesson.annotations)
            ? lesson.annotations.filter(isRecord).flatMap(annotation => {
                const annotationId = readString(annotation, 'annotationId');
                const isInlineAnnotation =
                  annotationId && readString(annotation, 'anchorKind') !== 'lesson';
                const note = readString(annotation, 'note');
                return isInlineAnnotation
                  ? [
                      {
                        annotationId,
                        hasNote: Boolean(note?.trim()),
                        kind: 'annotation' as const,
                        lessonId,
                        lessonTitle,
                        projectId,
                        projectTitle,
                      },
                    ]
                  : [];
              })
            : [];
          return [lessonReference, ...annotationReferences];
        });
      })
    : [];

const readArtifactReferences = (output: Record<string, unknown>): LibraryNavigationTarget[] =>
  Array.isArray(output.artifacts)
    ? output.artifacts.filter(isRecord).flatMap(artifact => {
        const projectId = readString(artifact, 'projectId');
        const projectTitle = readString(artifact, 'projectTitle');
        const lessonId = readString(artifact, 'lessonId');
        const lessonTitle = readString(artifact, 'lessonTitle');
        return projectId && projectTitle && lessonId && lessonTitle
          ? [{ kind: 'lesson', lessonId, lessonTitle, projectId, projectTitle } as const]
          : [];
      })
    : [];

const readProjectReferences = (output: Record<string, unknown>): LibraryNavigationTarget[] =>
  Array.isArray(output.projects)
    ? output.projects.filter(isRecord).flatMap(project => {
        const projectId = readString(project, 'id');
        const projectTitle = readString(project, 'title');
        if (!projectId || !projectTitle) return [];
        return [{ kind: 'project', projectId, projectTitle } as const];
      })
    : [];

const getToolName = (part: Extract<UIMessage['parts'][number], { toolCallId: string }>) =>
  'toolName' in part && typeof part.toolName === 'string'
    ? part.toolName
    : part.type.slice('tool-'.length);

export const getLibraryNavigationTargets = (
  parts: UIMessage['parts']
): LibraryNavigationTarget[] => {
  const references = parts.filter(isToolUIPart).flatMap(part => {
    if (part.state !== 'output-available' || !isRecord(part.output)) return [];
    switch (getToolName(part)) {
      case 'searchLibrary':
        return readSearchReferences(part.output);
      case 'getLessonDetails':
        return readLessonDetailReferences(part.output);
      case 'getLearningArtifacts':
        return readArtifactReferences(part.output);
      case 'getProjectStructures':
      case 'getProjectOverviews':
      case 'listLibraryTree':
        return readProjectReferences(part.output);
      default:
        return [];
    }
  });
  const seen = new Set<string>();
  return references.filter(reference => {
    const key = `${reference.projectId}:${reference.lessonId || ''}:${reference.annotationId || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const getReferenceLabel = (reference: LibraryNavigationTarget) => {
  if (reference.kind === 'annotation') {
    return t(
      reference.hasNote === false
        ? 'Apri evidenziazione in "{lessonTitle}" nel corso "{projectTitle}"'
        : 'Apri nota in "{lessonTitle}" nel corso "{projectTitle}"',
      {
        lessonTitle: reference.lessonTitle || reference.projectTitle,
        projectTitle: reference.projectTitle,
      }
    );
  }
  if (reference.kind === 'lesson') {
    return t('Apri lezione "{lessonTitle}" nel corso "{projectTitle}"', {
      lessonTitle: reference.lessonTitle || reference.projectTitle,
      projectTitle: reference.projectTitle,
    });
  }
  return t('Apri corso "{projectTitle}"', { projectTitle: reference.projectTitle });
};

const getReferenceIcon = (reference: LibraryNavigationTarget) => {
  if (reference.kind === 'annotation') return NotebookPen;
  if (reference.kind === 'lesson') return FileText;
  return BookOpen;
};

export default function LibraryToolReferences({
  onOpen,
  parts,
}: {
  readonly onOpen: (reference: LibraryNavigationTarget) => void;
  readonly parts: UIMessage['parts'];
}) {
  const references = getLibraryNavigationTargets(parts);
  if (references.length === 0) return null;
  return (
    <div className="space-y-2" data-testid="library-tool-references">
      <p className="text-[0.68rem] font-semibold uppercase tracking-[0.16em] text-stone-400 dark:text-stone-500">
        {t('Materiale recuperato')}
      </p>
      <div className="flex flex-wrap gap-2">
        {references.map(reference => {
          const Icon = getReferenceIcon(reference);
          return (
            <button
              key={`${reference.projectId}:${reference.lessonId || ''}:${reference.annotationId || ''}`}
              type="button"
              onClick={() => onOpen(reference)}
              className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-stone-200 bg-white px-3 py-1.5 text-xs font-medium text-stone-600 transition-colors hover:border-orange-300 hover:text-orange-700 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:border-orange-500/70 dark:hover:text-orange-200"
            >
              <Icon className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{getReferenceLabel(reference)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
