import assert from 'node:assert/strict';
import test from 'node:test';
import { LESSON_RESPONSE_SCHEMA } from './planning.ts';

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
