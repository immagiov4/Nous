import * as z from 'zod';

import { isRecord } from '../utils/validation.js';

const acceptsNull = (schema: Record<string, unknown>): boolean =>
  schema.type === 'null' ||
  (Array.isArray(schema.type) && schema.type.includes('null')) ||
  (Array.isArray(schema.anyOf) &&
    schema.anyOf.some(candidate => isRecord(candidate) && acceptsNull(candidate))) ||
  (Array.isArray(schema.oneOf) &&
    schema.oneOf.some(candidate => isRecord(candidate) && acceptsNull(candidate)));

const toStrictOutputSchema = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(toStrictOutputSchema);
  if (!isRecord(value)) return value;

  let converted = Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, toStrictOutputSchema(child)])
  );
  if (Array.isArray(converted.oneOf)) {
    const { oneOf, ...supportedSchema } = converted;
    converted = { ...supportedSchema, anyOf: oneOf };
  }
  if (converted.format === 'uri') {
    const { format: _unsupportedFormat, ...supportedSchema } = converted;
    converted = supportedSchema;
  }
  if (!isRecord(value.properties)) return converted;

  const originallyRequired = new Set(
    Array.isArray(value.required)
      ? value.required.filter((key): key is string => typeof key === 'string')
      : []
  );
  const properties = Object.fromEntries(
    Object.entries(converted.properties as Record<string, unknown>).map(
      ([key, convertedProperty]) => {
        if (
          originallyRequired.has(key) ||
          !isRecord(convertedProperty) ||
          acceptsNull(convertedProperty)
        ) {
          return [key, convertedProperty];
        }
        return [key, { anyOf: [convertedProperty, { type: 'null' }] }];
      }
    )
  );
  return { ...converted, properties, required: Object.keys(properties) };
};

const normalizeUnion = (
  value: unknown,
  branches: readonly unknown[],
  branchValidators: WeakMap<Record<string, unknown>, z.ZodType>
): unknown => {
  for (const branch of branches) {
    if (!isRecord(branch)) continue;
    const normalized = omitOptionalNulls(value, branch, branchValidators);
    let validator = branchValidators.get(branch);
    if (!validator) {
      validator = z.fromJSONSchema(branch);
      branchValidators.set(branch, validator);
    }
    if (validator.safeParse(normalized).success) return normalized;
  }
  // Invalid model output remains available for the caller's domain validation.
  return value;
};

const omitOptionalNulls = (
  value: unknown,
  schema: unknown,
  branchValidators: WeakMap<Record<string, unknown>, z.ZodType>
): unknown => {
  if (!isRecord(schema)) return value;
  const branches = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(branches)) return normalizeUnion(value, branches, branchValidators);
  if (Array.isArray(value)) {
    return value.map(entry => omitOptionalNulls(entry, schema.items, branchValidators));
  }
  if (!isRecord(value) || !isRecord(schema.properties)) return value;

  const properties = schema.properties;
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter((key): key is string => typeof key === 'string')
      : []
  );
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, child]) => {
      const propertySchema = properties[key];
      if (
        child === null &&
        !required.has(key) &&
        isRecord(propertySchema) &&
        !acceptsNull(propertySchema)
      ) {
        return [];
      }
      return [[key, omitOptionalNulls(child, propertySchema, branchValidators)]];
    })
  );
};

/** Adapts only the provider request; normalization restores domain optionality before validation. */
export const prepareStrictStructuredOutput = (schema: Record<string, unknown>) => {
  const strictSchema = toStrictOutputSchema(schema) as Record<string, unknown>;
  const branchValidators = new WeakMap<Record<string, unknown>, z.ZodType>();
  const wrapsRootValue = strictSchema.type !== 'object';
  return {
    schema: wrapsRootValue
      ? {
          additionalProperties: false,
          properties: { result: strictSchema },
          required: ['result'],
          type: 'object',
        }
      : strictSchema,
    normalize: (response: unknown): unknown => {
      const output = wrapsRootValue && isRecord(response) ? response.result : response;
      return omitOptionalNulls(output, schema, branchValidators);
    },
  };
};
