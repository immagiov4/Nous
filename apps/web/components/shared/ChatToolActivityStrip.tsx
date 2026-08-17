import { CONTEXT_SOURCE_ARCHIVE_TOOL_NAME } from '@shared/lessonSourceContext';
import { isToolUIPart, type UIMessage } from 'ai';
import type { LucideIcon } from 'lucide-react';
import {
  BookOpen,
  FileSearch,
  FileText,
  GitFork,
  Globe,
  List,
  Search,
  Sparkles,
  StickyNote,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';
import { translateUiMessage as t } from '../../i18n/uiMessages.ts';

type ChatToolPart = Extract<UIMessage['parts'][number], { toolCallId: string }>;

const TOOL_HINT_MAX_LENGTH = 30;
const TOOL_CHIP_FADE_TRANSITION = 'opacity 0.35s ease';
const VISIBLE_TOOL_LIMIT = {
  desktop: 4,
  mobile: 2,
} as const;

const TOOL_META: Record<string, { icon: LucideIcon; getLabel: () => string }> = {
  generateCurrentLessonArtifact: { icon: Sparkles, getLabel: () => t('Genera artefatto') },
  generateLearningArtifact: { icon: Sparkles, getLabel: () => t('Genera artefatto') },
  getCurrentLessonArtifacts: { icon: FileText, getLabel: () => t('Artefatti lezione') },
  getLessonDetails: { icon: FileText, getLabel: () => t('Dettagli lezioni') },
  getLearningArtifacts: { icon: FileText, getLabel: () => t('Artefatti lezioni') },
  getProjectOverviews: { icon: BookOpen, getLabel: () => t('Panoramica corsi') },
  getProjectStructures: { icon: GitFork, getLabel: () => t('Struttura corsi') },
  listLibraryTree: { icon: List, getLabel: () => t('Indice libreria') },
  requestAddToNotes: { icon: StickyNote, getLabel: () => t('Salva nota') },
  requestSaveLearningArtifactNote: { icon: FileText, getLabel: () => t('Salva nota') },
  [CONTEXT_SOURCE_ARCHIVE_TOOL_NAME]: {
    icon: FileSearch,
    getLabel: () => t('Consulta sorgente'),
  },
  searchLibrary: { icon: Search, getLabel: () => t('Ricerca contenuti') },
  searchWeb: { icon: Globe, getLabel: () => t('Ricerca web') },
  startCourseAssessment: { icon: BookOpen, getLabel: () => t('Avvio nuovo corso') },
};

const isVisibleToolState = (state: ChatToolPart['state']) =>
  state === 'input-streaming' ||
  state === 'input-available' ||
  state === 'approval-requested' ||
  state === 'approval-responded' ||
  state === 'output-available' ||
  state === 'output-error' ||
  state === 'output-denied';

const isPendingToolState = (state: ChatToolPart['state']) =>
  state === 'input-streaming' || state === 'input-available' || state === 'approval-requested';

const getToolName = (part: ChatToolPart) =>
  'toolName' in part && typeof part.toolName === 'string'
    ? part.toolName
    : part.type.slice('tool-'.length);

const getToolMeta = (part: ChatToolPart) => {
  const toolName = getToolName(part);
  const configuredMeta = TOOL_META[toolName];
  return configuredMeta
    ? { icon: configuredMeta.icon, label: configuredMeta.getLabel() }
    : {
        icon: Search,
        label: toolName.replaceAll(/([A-Z])/g, ' $1').trim() || t('Tool'),
      };
};

const getCountHint = (count: number, singular: string, plural: string) => {
  if (count === 0) return null;
  return count === 1 ? singular : plural;
};

const getTruncatedHint = (value: unknown) => {
  if (typeof value !== 'string' || !value) return null;
  return value.length > TOOL_HINT_MAX_LENGTH
    ? `${value.slice(0, TOOL_HINT_MAX_LENGTH)}\u2026`
    : value;
};

const getProjectCountHint = (input: Record<string, unknown>) => {
  const ids = input.projectIds;
  if (!Array.isArray(ids)) return null;
  return getCountHint(ids.length, t('1 corso'), t('{count} corsi', { count: ids.length }));
};

const getLessonCountHint = (input: Record<string, unknown>) => {
  const requests = input.requests;
  if (!Array.isArray(requests)) return null;
  const count = requests.reduce((sum, request) => {
    if (!request || typeof request !== 'object' || !('lessonIds' in request)) return sum;
    return sum + (Array.isArray(request.lessonIds) ? request.lessonIds.length : 0);
  }, 0);
  return getCountHint(count, t('1 lezione'), t('{count} lezioni', { count }));
};

const getToolArgHint = (part: ChatToolPart): string | null => {
  if (part.state === 'input-streaming') return null;
  const input = (part as { input?: Record<string, unknown> }).input;
  if (!input) return null;
  switch (getToolName(part)) {
    case 'getProjectStructures':
    case 'getProjectOverviews':
      return getProjectCountHint(input);
    case 'getLessonDetails':
      return getLessonCountHint(input);
    case 'searchLibrary':
    case 'searchWeb':
      return getTruncatedHint(input.query);
    case 'startCourseAssessment':
      return getTruncatedHint(input.topic);
    default:
      return null;
  }
};

const ToolChipFadeIn = ({ children }: { children: ReactNode }) => {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(id);
  }, []);
  return (
    <span
      className="inline-flex min-w-0 flex-1 items-center gap-x-1.5"
      style={{ opacity: visible ? 1 : 0, transition: TOOL_CHIP_FADE_TRANSITION }}
    >
      {children}
    </span>
  );
};

export default function ChatToolActivityStrip({
  isMobileViewport,
  messageId,
  parts,
}: {
  readonly isMobileViewport: boolean;
  readonly messageId: string;
  readonly parts: UIMessage['parts'];
}) {
  const toolParts = parts.filter(isToolUIPart).filter(part => isVisibleToolState(part.state));
  if (toolParts.length === 0) return null;
  const maxTools = isMobileViewport ? VISIBLE_TOOL_LIMIT.mobile : VISIBLE_TOOL_LIMIT.desktop;
  const truncated = toolParts.length > maxTools;
  const visibleTools = toolParts.slice(-maxTools);
  return (
    <div
      data-testid="chat-tool-activity"
      className="flex min-w-0 flex-nowrap items-center gap-x-2 overflow-hidden py-1.5 text-xs text-gray-600 dark:text-zinc-300"
    >
      {truncated ? <span className="shrink-0 text-gray-400 dark:text-zinc-500">…</span> : null}
      {visibleTools.map((part, index) => {
        const meta = getToolMeta(part);
        const hint = getToolArgHint(part);
        const Icon = meta.icon;
        return (
          <span
            key={`${messageId}-${part.toolCallId}`}
            className="inline-flex min-w-0 max-w-full flex-[0_1_auto] items-center gap-x-1.5"
          >
            {index > 0 || truncated ? (
              <span className="shrink-0 text-gray-300 dark:text-zinc-600">&#8594;</span>
            ) : null}
            <ToolChipFadeIn>
              <Icon className="h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 truncate font-medium">{meta.label}</span>
              {hint ? (
                <span className="min-w-0 truncate text-gray-400 dark:text-zinc-500">{hint}</span>
              ) : null}
            </ToolChipFadeIn>
          </span>
        );
      })}
      {toolParts.some(part => isPendingToolState(part.state)) ? (
        <span className="ml-0.5 h-2 w-2 animate-pulse rounded-full bg-amber-400 dark:bg-amber-300" />
      ) : null}
    </div>
  );
}
