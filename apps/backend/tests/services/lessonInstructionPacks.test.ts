import {
  buildLessonVerificationChecklist,
  VISUAL_LEARNING_REQUIRED_REPRESENTATION_RULE,
} from '@shared/lessonInstructionPacks';
import { describe, expect, test } from 'vitest';

describe('lesson instruction packs', () => {
  test('treats visual-learning as an explicit representation requirement', () => {
    const checklist = buildLessonVerificationChecklist(['visual-learning']);
    const requirement = checklist.find(item => item.checkId === 'visual-learning.4');

    expect(requirement).toEqual({
      checkId: 'visual-learning.4',
      instruction: VISUAL_LEARNING_REQUIRED_REPRESENTATION_RULE,
    });
  });
});
