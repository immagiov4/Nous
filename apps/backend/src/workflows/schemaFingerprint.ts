import type { ZodType } from 'zod';

const DURABLE_SCHEMA_TYPES = new Set([
  'array',
  'boolean',
  'enum',
  'intersection',
  'literal',
  'nonoptional',
  'null',
  'nullable',
  'number',
  'object',
  'optional',
  'readonly',
  'record',
  'string',
  'tuple',
  'union',
]);

const NON_STRUCTURAL_FUNCTION_KEYS = new Set(['error', 'when']);
const ORDER_INDEPENDENT_ARRAY_KEYS = new Set(['checks', 'values']);

interface ZodInternals {
  _zod: { def: Record<string, unknown> };
}

const isZodSchema = (value: unknown): value is ZodType & ZodInternals =>
  typeof value === 'object' && value !== null && '_zod' in value;

const compareCodeUnits = (left: string, right: string): number => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

const normalizeCanonicalValue = (value: unknown, path: string): unknown => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Non-finite number at ${path}.`);
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => normalizeCanonicalValue(entry, `${path}[${index}]`));
  }
  if (typeof value !== 'object' || value === undefined) {
    throw new Error(`Non-serializable value at ${path}.`);
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([key, child]) => [key, normalizeCanonicalValue(child, `${path}.${key}`)])
  );
};

export const canonicalJson = (value: unknown): string =>
  JSON.stringify(normalizeCanonicalValue(value, 'value'));

interface SchemaNormalization {
  stack: Set<object>;
  shapes: WeakMap<object, unknown>;
}

const normalizeDefinitionValue = (
  value: unknown,
  path: string,
  context: SchemaNormalization,
  key?: string,
  allowOptional = false
): unknown => {
  if (isZodSchema(value)) return normalizeSchema(value, path, context, allowOptional);
  if (value instanceof RegExp) return { flags: value.flags, source: value.source };
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(`Unsupported durable schema at ${path}: non-finite number`);
    }
    return value;
  }
  if (typeof value === 'function') {
    if (key && NON_STRUCTURAL_FUNCTION_KEYS.has(key)) return undefined;
    throw new Error(`Unsupported durable schema at ${path}: callback`);
  }
  if (Array.isArray(value)) {
    const normalized = value.map((entry, index) =>
      normalizeDefinitionValue(entry, `${path}[${index}]`, context)
    );
    return key && ORDER_INDEPENDENT_ARRAY_KEYS.has(key)
      ? normalized.sort((left, right) =>
          compareCodeUnits(canonicalJson(left), canonicalJson(right))
        )
      : normalized;
  }
  if (typeof value !== 'object' || value === undefined) {
    throw new Error(`Unsupported durable schema at ${path}: non-serializable value`);
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([childKey, child]) => [
        childKey,
        normalizeDefinitionValue(child, `${path}.${childKey}`, context, childKey, key === 'shape'),
      ])
      .filter(([, child]) => child !== undefined)
  );
};

const normalizeCheck = (value: unknown, path: string, context: SchemaNormalization): unknown => {
  if (!isZodSchema(value)) {
    throw new Error(`Unsupported durable schema at ${path}: unknown check`);
  }
  const definition = value._zod.def;
  const check = definition.check;
  if (check === 'custom' || check === 'overwrite') {
    throw new Error(`Unsupported durable schema at ${path}: ${check}`);
  }
  return normalizeDefinitionValue(definition, path, context);
};

const normalizeSchema = (
  schema: ZodType & ZodInternals,
  path: string,
  context: SchemaNormalization,
  allowOptional = false
): unknown => {
  if (context.stack.has(schema))
    throw new Error(`Unsupported durable schema at ${path}: recursive schema`);
  context.stack.add(schema);
  try {
    const definition = schema._zod.def;
    const schemaType = String(definition.type);
    if (!DURABLE_SCHEMA_TYPES.has(schemaType)) {
      throw new Error(`Unsupported durable schema at ${path}: ${schemaType}`);
    }
    if (schemaType === 'optional' && !allowOptional) {
      throw new Error(
        `Unsupported durable schema at ${path}: optional values are only allowed as object properties`
      );
    }
    if (definition.coerce === true) {
      throw new Error(`Unsupported durable schema at ${path}: coerce`);
    }

    const cached = context.shapes.get(schema);
    if (cached !== undefined) return cached;
    const shape = Object.fromEntries(
      Object.entries(definition)
        .filter(([key, value]) => key !== 'type' && value !== undefined)
        .sort(([left], [right]) => compareCodeUnits(left, right))
        .map<[string, unknown]>(([key, value]) => [
          key,
          key === 'checks' && Array.isArray(value)
            ? value
                .map((check, index) => normalizeCheck(check, `${path}.checks[${index}]`, context))
                .sort((left, right) => compareCodeUnits(canonicalJson(left), canonicalJson(right)))
            : normalizeDefinitionValue(value, `${path}.${key}`, context, key),
        ])
        .concat([['type', schemaType]])
        .sort(([left], [right]) => compareCodeUnits(left, right))
    );
    context.shapes.set(schema, shape);
    return shape;
  } finally {
    context.stack.delete(schema);
  }
};

// Reuse shared subtrees only within this traversal; later calls must observe schema mutations.
export const durableSchemaShape = (schema: ZodType, path = 'schema'): unknown => {
  if (!isZodSchema(schema))
    throw new Error(`Unsupported durable schema at ${path}: invalid schema`);
  return normalizeSchema(schema, path, { stack: new Set(), shapes: new WeakMap() });
};

export const schemasMatch = (left: ZodType, right: ZodType): boolean =>
  canonicalJson(durableSchemaShape(left)) === canonicalJson(durableSchemaShape(right));
