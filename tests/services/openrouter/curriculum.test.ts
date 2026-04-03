import assert from 'node:assert/strict';
import { test } from 'vitest';
import { CURRICULUM_PROPEDEUTIC_ORDER_RULES } from '../../../services/openrouter/curriculum.ts';

test('CURRICULUM_PROPEDEUTIC_ORDER_RULES keep new courses in prerequisite order', () => {
  assert.ok(
    CURRICULUM_PROPEDEUTIC_ORDER_RULES.some(rule => rule.includes('ordine strettamente propedeutico'))
  );
  assert.ok(
    CURRICULUM_PROPEDEUTIC_ORDER_RULES.some(rule => rule.includes('moduli') && rule.includes('fondamenta'))
  );
  assert.ok(
    CURRICULUM_PROPEDEUTIC_ORDER_RULES.some(rule => rule.includes('lezioni') && rule.includes('semplice al complesso'))
  );
  assert.ok(
    CURRICULUM_PROPEDEUTIC_ORDER_RULES.some(rule => rule.includes('prerequisiti') && rule.includes('devono comparire prima'))
  );
});

test('lesson curriculum prompt rules require expanding unexplained acronyms', async () => {
  const { generateLearnLessonContent } = await import('../../../services/openrouter/curriculum.ts');

  const source = generateLearnLessonContent.toString();
  assert.match(source, /Do not use unexplained acronyms or abbreviations/i);
  assert.match(source, /always expand them/i);
  assert.match(source, /Avoid unnecessary foreign words/i);
});
