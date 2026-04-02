import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  CONTEXT_ANSWER_MIN_HEIGHT,
  CONTEXT_ANSWER_MIN_WIDTH,
  clampContextAnswerPanelSize,
  resolveExpandedModuleState,
} from './readerChrome.ts';
import type { SidebarGroup } from './workspaceReader.ts';

const sidebarGroups: SidebarGroup[] = [
  {
    id: 'group-a',
    sectionDepthById: {
      'lesson-a1': 0,
    },
    title: 'Modulo A',
    sections: [
      {
        id: 'lesson-a1',
        title: 'Intro',
        description: 'Base',
        isCompleted: true,
        type: 'core',
      },
    ],
  },
  {
    id: 'group-b',
    sectionDepthById: {
      'lesson-b1': 0,
    },
    title: 'Modulo B',
    sections: [
      {
        id: 'lesson-b1',
        title: 'Approfondimento',
        description: 'Step 2',
        isCompleted: false,
        type: 'core',
      },
    ],
  },
];

test('clampContextAnswerPanelSize respects viewport and minimum constraints', () => {
  assert.deepEqual(
    clampContextAnswerPanelSize({ width: 120, height: 900 }, { width: 640, height: 480 }),
    {
      width: CONTEXT_ANSWER_MIN_WIDTH,
      height: 448,
    }
  );

  assert.deepEqual(
    clampContextAnswerPanelSize({ width: 9999, height: 10 }, { width: 700, height: 500 }),
    {
      width: 668,
      height: CONTEXT_ANSWER_MIN_HEIGHT,
    }
  );
});

test('resolveExpandedModuleState opens the first incomplete group when current one is missing', () => {
  assert.deepEqual(
    resolveExpandedModuleState({
      activeSectionId: 'lesson-b1',
      currentExpandedModuleId: 'missing',
      previousActiveSectionId: null,
      sidebarGroups,
    }),
    {
      expandedModuleId: 'group-b',
      previousActiveSectionId: 'lesson-b1',
    }
  );
});

test('resolveExpandedModuleState follows the active section when it changes group', () => {
  assert.deepEqual(
    resolveExpandedModuleState({
      activeSectionId: 'lesson-b1',
      currentExpandedModuleId: 'group-a',
      previousActiveSectionId: 'lesson-a1',
      sidebarGroups,
    }),
    {
      expandedModuleId: 'group-b',
      previousActiveSectionId: 'lesson-b1',
    }
  );
});

test('resolveExpandedModuleState preserves a manual close while the active section is unchanged', () => {
  assert.deepEqual(
    resolveExpandedModuleState({
      activeSectionId: 'lesson-b1',
      currentExpandedModuleId: null,
      previousActiveSectionId: 'lesson-b1',
      sidebarGroups,
    }),
    {
      expandedModuleId: null,
      previousActiveSectionId: 'lesson-b1',
    }
  );
});

test('resolveExpandedModuleState reopens the active group after a manual close when the active section changes', () => {
  assert.deepEqual(
    resolveExpandedModuleState({
      activeSectionId: 'lesson-a1',
      currentExpandedModuleId: null,
      previousActiveSectionId: 'lesson-b1',
      sidebarGroups,
    }),
    {
      expandedModuleId: 'group-a',
      previousActiveSectionId: 'lesson-a1',
    }
  );
});
