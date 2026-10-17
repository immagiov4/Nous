import { expect, test } from 'vitest';
import * as z from 'zod';
import { WorkflowExecutionDefaultsSchema } from '../../src/workflows/config.js';
import { step, workflow } from '../../src/workflows/definition.js';
import {
  canonicalJson,
  createSchemaFingerprinter,
  durableSchemaShape,
} from '../../src/workflows/schemaFingerprint.js';
import { validateWorkflowDefinition } from '../../src/workflows/validation.js';

test('reuses a shared subtree while preserving its canonical bytes', () => {
  let reads = 0;
  const shared = z.object({
    get value() {
      reads++;
      return z.string();
    },
  });
  const fingerprinter = createSchemaFingerprinter();
  const first = fingerprinter.shape(z.object({ left: shared }));
  const afterFirst = reads;
  const second = fingerprinter.shape(z.object({ right: shared }));
  expect(reads).toBe(afterFirst);
  expect(canonicalJson(first)).toBe(canonicalJson(durableSchemaShape(z.object({ left: shared }))));
  expect(canonicalJson(second)).toBe(
    canonicalJson(durableSchemaShape(z.object({ right: shared })))
  );
});

test('a new validation observes changes to shared schemas', () => {
  const schema = z.object({ value: z.string() });
  const original = canonicalJson(createSchemaFingerprinter().shape(schema));
  schema.shape.value._zod.def.checks = [z.minLength(1)];
  expect(canonicalJson(createSchemaFingerprinter().shape(schema))).not.toBe(original);
});

test('a cached optional property still fails at a required boundary', () => {
  const optional = z.string().optional();
  const fingerprinter = createSchemaFingerprinter();
  fingerprinter.shape(z.object({ value: optional }));
  expect(() => fingerprinter.shape(optional, 'workflow.input')).toThrow(
    'Unsupported durable schema at workflow.input: optional values are only allowed as object properties'
  );
  expect(() => fingerprinter.shape(z.array(optional))).toThrow(
    'optional values are only allowed as object properties'
  );
});

test('canonical JSON preserves shared object bytes and observes later mutations', () => {
  const shared = { z: 1, a: ['value', null] };
  const input = { right: shared, left: shared };
  expect(canonicalJson(input)).toBe(
    '{"left":{"a":["value",null],"z":1},"right":{"a":["value",null],"z":1}}'
  );
  shared.z = 2;
  expect(canonicalJson(input)).toBe(
    '{"left":{"a":["value",null],"z":2},"right":{"a":["value",null],"z":2}}'
  );
});

test('normalizes each shared schema once per definition validation', () => {
  let reads = 0;
  const text = z.string();
  Object.defineProperty(text._zod.def, 'checks', {
    enumerable: true,
    get: () => {
      reads++;
      return [];
    },
  });
  const schema = z.object({ text });
  const definition = workflow({
    compatibilityId: 'shared-schema-v1',
    configSchema: WorkflowExecutionDefaultsSchema,
    executionDefaults: { maxAttempts: 3, timeoutMs: 60_000 },
    id: 'shared-schema',
    inputSchema: schema,
    outputSchema: schema,
    root: step({
      id: 'echo',
      inputSchema: schema,
      outputSchema: schema,
      run: async ({ input }) => input,
    }),
  });
  validateWorkflowDefinition(definition);
  expect(reads).toBe(1);
  validateWorkflowDefinition(definition);
  expect(reads).toBe(2);
});
