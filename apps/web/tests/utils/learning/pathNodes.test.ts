import { describe, expect, it } from 'vitest';
import {
  flattenPathNodes,
  flattenLessons,
  findPathNodeById,
  updateLessons,
} from '../../../utils/learning/pathNodes.ts';
import type { LearningModule } from '../../../types.ts';

const modules = (): LearningModule[] => [
  {
    id: 'm0',
    title: 'A',
    children: [
      {
        kind: 'lesson',
        id: 'L1',
        title: 'L1',
        description: '',
        isCompleted: false,
        type: 'core',
      },
      {
        kind: 'lesson',
        id: 'L2',
        title: 'L2',
        description: '',
        isCompleted: false,
        type: 'core',
      },
    ],
  },
  {
    id: 'm1',
    title: 'B',
    children: [
      {
        kind: 'lesson',
        id: 'L3',
        title: 'L3',
        description: '',
        isCompleted: false,
        type: 'core',
      },
    ],
  },
];

describe('pathNodes helpers', () => {
  it('flattenPathNodes preserves module order', () => {
    expect(flattenPathNodes(modules()).map(n => n.id)).toEqual(['L1', 'L2', 'L3']);
  });

  it('flattenLessons returns only LessonNodes', () => {
    const lessons = flattenLessons(modules());
    expect(lessons.every(l => l.kind === 'lesson')).toBe(true);
    expect(lessons).toHaveLength(3);
  });

  it('findPathNodeById walks every module', () => {
    expect(findPathNodeById(modules(), 'L3')?.id).toBe('L3');
    expect(findPathNodeById(modules(), 'missing')).toBeNull();
  });

  it('handles null/undefined input', () => {
    expect(flattenPathNodes(null)).toEqual([]);
    expect(flattenLessons(null)).toEqual([]);
    expect(findPathNodeById(null, 'x')).toBeNull();
  });

  it('updateLessons applies the updater to every lesson and leaves module count intact', () => {
    const next = updateLessons(modules(), lesson => ({ ...lesson, isCompleted: true }));
    expect(flattenLessons(next).every(l => l.isCompleted)).toBe(true);
    expect(next).toHaveLength(2);
  });
});
