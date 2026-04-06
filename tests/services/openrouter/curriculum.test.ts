import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import { CURRICULUM_PROPEDEUTIC_ORDER_RULES } from '../../../services/openrouter/curriculum.ts';

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
});
