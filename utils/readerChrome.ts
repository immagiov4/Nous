import type { SidebarGroup } from './workspaceReader.ts';

export interface ContextAnswerSize {
  width: number;
  height: number;
}

export interface ResolveExpandedModuleStateArgs {
  activeSectionId: string | null;
  currentExpandedModuleId: string | null;
  previousActiveSectionId: string | null;
  sidebarGroups: SidebarGroup[];
}

export interface ExpandedModuleState {
  expandedModuleId: string | null;
  previousActiveSectionId: string | null;
}

export const CONTEXT_ANSWER_DEFAULT_SIZE: ContextAnswerSize = {
  width: 512,
  height: 544,
};

export const CONTEXT_ANSWER_MIN_WIDTH = 352;
export const CONTEXT_ANSWER_MIN_HEIGHT = 256;
export const CONTEXT_ANSWER_VIEWPORT_MARGIN = 32;

export const clampContextAnswerPanelSize = (
  size: ContextAnswerSize,
  viewport: { width: number; height: number }
): ContextAnswerSize => {
  const maxWidth = Math.max(
    CONTEXT_ANSWER_MIN_WIDTH,
    viewport.width - CONTEXT_ANSWER_VIEWPORT_MARGIN
  );
  const maxHeight = Math.max(
    CONTEXT_ANSWER_MIN_HEIGHT,
    viewport.height - CONTEXT_ANSWER_VIEWPORT_MARGIN
  );

  return {
    width: Math.min(Math.max(size.width, CONTEXT_ANSWER_MIN_WIDTH), maxWidth),
    height: Math.min(Math.max(size.height, CONTEXT_ANSWER_MIN_HEIGHT), maxHeight),
  };
};

export const resolveExpandedModuleState = ({
  activeSectionId,
  currentExpandedModuleId,
  previousActiveSectionId,
  sidebarGroups,
}: ResolveExpandedModuleStateArgs): ExpandedModuleState => {
  if (sidebarGroups.length === 0) {
    return {
      expandedModuleId: null,
      previousActiveSectionId: null,
    };
  }

  const currentGroupStillExists = currentExpandedModuleId
    ? sidebarGroups.some(group => group.id === currentExpandedModuleId)
    : false;

  if (!currentGroupStillExists) {
    const nextGroup =
      sidebarGroups.find(group => group.sections.some(section => !section.isCompleted)) ||
      sidebarGroups[0];

    return {
      expandedModuleId: nextGroup.id,
      previousActiveSectionId: activeSectionId,
    };
  }

  if (!activeSectionId || previousActiveSectionId === activeSectionId) {
    return {
      expandedModuleId: currentExpandedModuleId,
      previousActiveSectionId,
    };
  }

  const activeGroup = sidebarGroups.find(group =>
    group.sections.some(section => section.id === activeSectionId)
  );

  return {
    expandedModuleId: activeGroup?.id || currentExpandedModuleId,
    previousActiveSectionId: activeSectionId,
  };
};
