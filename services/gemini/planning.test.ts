import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  LESSON_RESPONSE_SCHEMA,
  LESSON_SCOPE_RULES,
  PLAN_PROPEDEUTIC_ORDER_RULES,
} from './planning.ts';

test('LESSON_RESPONSE_SCHEMA marks all image placement keys as required for strict json schema', () => {
  const imagePlacementSchema = (
    (LESSON_RESPONSE_SCHEMA.schema as { properties: Record<string, unknown> }).properties
      .imagePlacements as {
      items: {
        properties: Record<string, unknown>;
        required: string[];
      };
    }
  ).items;

  assert.deepEqual(imagePlacementSchema.required, [
    'assetId',
    'alt',
    'caption',
    'anchorHeading',
  ]);
  assert.deepEqual(imagePlacementSchema.properties.caption, {
    type: ['string', 'null'],
  });
  assert.deepEqual(imagePlacementSchema.properties.anchorHeading, {
    type: ['string', 'null'],
  });
});

test('LESSON_SCOPE_RULES prevent future-lesson spoilers and filler deep dives', () => {
  assert.ok(
    LESSON_SCOPE_RULES.some(rule => rule.includes('Non anticipare in dettaglio argomenti che verranno trattati in lezioni future'))
  );
  assert.ok(
    LESSON_SCOPE_RULES.some(rule => rule.includes('Non inserire sezioni di "analisi approfondita"'))
  );
  assert.ok(
    LESSON_SCOPE_RULES.some(rule => rule.includes('Se la lezione ha gia esaurito il suo focus, chiudi con naturalezza'))
  );
});

test('PLAN_PROPEDEUTIC_ORDER_RULES enforce prerequisite ordering for modules and lessons', () => {
  assert.ok(
    PLAN_PROPEDEUTIC_ORDER_RULES.some(rule => rule.includes('moduli/capitoli') && rule.includes('lezioni interne'))
  );
  assert.ok(
    PLAN_PROPEDEUTIC_ORDER_RULES.some(rule => rule.includes('Ogni modulo deve preparare il successivo'))
  );
  assert.ok(
    PLAN_PROPEDEUTIC_ORDER_RULES.some(rule => rule.includes('raffinamento') && rule.includes('riordinale'))
  );
  assert.ok(
    PLAN_PROPEDEUTIC_ORDER_RULES.some(rule => rule.includes('elementi invertiti') && rule.includes("correggi l'ordine"))
  );
});
