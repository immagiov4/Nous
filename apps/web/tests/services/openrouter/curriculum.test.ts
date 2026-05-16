import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { CURRICULUM_PROPEDEUTIC_ORDER_RULES } from '../../../services/openrouter/curriculum.ts';
import { LESSON_SHARED_WRITING_RULES } from '../../../services/openrouter/prompts.ts';

// These tests guard against accidental prompt modification. They are intentionally static.
describe('prompt invariants — intentional guardrails, not behavior tests', () => {
  test('CURRICULUM_PROPEDEUTIC_ORDER_RULES keep new courses in prerequisite order', () => {
    assert.ok(
      CURRICULUM_PROPEDEUTIC_ORDER_RULES.some(rule =>
        rule.includes('ordine strettamente propedeutico')
      )
    );
    assert.ok(
      CURRICULUM_PROPEDEUTIC_ORDER_RULES.some(
        rule => rule.includes('moduli') && rule.includes('fondamenta')
      )
    );
    assert.ok(
      CURRICULUM_PROPEDEUTIC_ORDER_RULES.some(
        rule => rule.includes('lezioni') && rule.includes('semplice al complesso')
      )
    );
    assert.ok(
      CURRICULUM_PROPEDEUTIC_ORDER_RULES.some(
        rule => rule.includes('prerequisiti') && rule.includes('devono comparire prima')
      )
    );
  });

  test('LESSON_SHARED_WRITING_RULES reject rigid English template headings', () => {
    assert.ok(LESSON_SHARED_WRITING_RULES.includes('NON usare intestazioni inglesi'));
    for (const forbiddenHeading of [
      'The Concept',
      'The Architecture',
      'The Implementation',
      'The Trap',
    ]) {
      assert.equal(LESSON_SHARED_WRITING_RULES.includes(forbiddenHeading), false);
    }
  });
});
