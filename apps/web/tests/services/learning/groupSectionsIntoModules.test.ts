import { describe, expect, it } from 'vitest';
import { groupSectionsIntoModules } from '../../../services/learning/groupSectionsIntoModules.ts';
import type { LearningSection } from '../../../types.ts';

const section = (id: string, overrides: Partial<LearningSection> = {}): LearningSection => ({
  id,
  title: `Lesson ${id}`,
  description: '',
  isCompleted: false,
  type: 'core',
  ...overrides,
});

describe('groupSectionsIntoModules', () => {
  it('returns empty modules for empty input', () => {
    expect(groupSectionsIntoModules([])).toEqual([]);
  });

  it('places no-moduleTitle sections in a single Untitled module', () => {
    const result = groupSectionsIntoModules([section('a'), section('b')]);
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('Untitled module');
    expect(result[0].children).toHaveLength(2);
    expect(result[0].children[0].kind).toBe('lesson');
  });

  it('groups consecutive sections sharing moduleTitle', () => {
    const result = groupSectionsIntoModules([
      section('a', { moduleTitle: 'Foundations' }),
      section('b', { moduleTitle: 'Foundations' }),
      section('c', { moduleTitle: 'Applications' }),
    ]);
    expect(result.map(m => m.title)).toEqual(['Foundations', 'Applications']);
    expect(result[0].children).toHaveLength(2);
    expect(result[1].children).toHaveLength(1);
  });

  it('starts a new module when moduleTitle changes back', () => {
    const result = groupSectionsIntoModules([
      section('a', { moduleTitle: 'A' }),
      section('b', { moduleTitle: 'B' }),
      section('c', { moduleTitle: 'A' }),
    ]);
    expect(result.map(m => m.title)).toEqual(['A', 'B', 'A']);
    expect(new Set(result.map(m => m.id)).size).toBe(3);
  });

  it('preserves parentId sub-chapters within their parent module', () => {
    const result = groupSectionsIntoModules([
      section('parent', { moduleTitle: 'M' }),
      section('child', { moduleTitle: 'M', parentId: 'parent' }),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].children).toHaveLength(2);
    const child = result[0].children[1];
    expect(child.kind).toBe('lesson');
    if (child.kind === 'lesson') {
      expect(child.parentId).toBe('parent');
    }
  });

  it('produces stable IDs across repeat calls on identical input', () => {
    const sections = [section('a', { moduleTitle: 'M' }), section('b', { moduleTitle: 'N' })];
    const first = groupSectionsIntoModules(sections);
    const second = groupSectionsIntoModules(sections);
    expect(first.map(m => m.id)).toEqual(second.map(m => m.id));
  });

  it('derives module type when all children share the same LearningSection.type', () => {
    const result = groupSectionsIntoModules([
      section('a', { moduleTitle: 'Intro', type: 'prerequisite' }),
      section('b', { moduleTitle: 'Intro', type: 'prerequisite' }),
      section('c', { moduleTitle: 'Body', type: 'core' }),
      section('d', { moduleTitle: 'Body', type: 'summary' }),
    ]);
    expect(result[0].type).toBe('prerequisite');
    expect(result[1].type).toBeUndefined();
  });

  it('strips moduleTitle off the LessonNode children and stamps kind=lesson', () => {
    const result = groupSectionsIntoModules([section('a', { moduleTitle: 'M' })]);
    const child = result[0].children[0];
    expect(child.kind).toBe('lesson');
    expect((child as unknown as Record<string, unknown>).moduleTitle).toBeUndefined();
  });
});
