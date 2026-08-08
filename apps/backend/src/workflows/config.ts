import type { ZodType } from 'zod';
import * as z from 'zod';

import { isRecord } from '../utils/validation.js';
import type { UnsetConfigValue, WorkflowExecutionDefaults } from './types.js';

const UNSET_CONFIG_VALUE = Symbol('unset workflow config value');
const REMOVED = Symbol('removed workflow config property');
export const POSTGRES_INTEGER_MAX = 2_147_483_647;

const unsetValue = Object.freeze({
  [UNSET_CONFIG_VALUE]: true as const,
}) as unknown as UnsetConfigValue;

export const unset = (): UnsetConfigValue => unsetValue;

export const isUnsetConfigValue = (value: unknown): value is UnsetConfigValue =>
  value === unsetValue;

const mergeValue = (base: unknown, override: unknown): unknown => {
  if (isUnsetConfigValue(override)) return REMOVED;
  if (override === undefined) return cloneValue(base);
  if (Array.isArray(override)) return override.map(cloneValue);
  if (!isRecord(override)) return override;

  const inherited = isRecord(base) ? base : {};
  const mergedEntries: [string, unknown][] = [];
  for (const key of new Set([...Object.keys(inherited), ...Object.keys(override)])) {
    const inheritedValue = Object.hasOwn(inherited, key) ? inherited[key] : undefined;
    const overrideValue = Object.hasOwn(override, key) ? override[key] : undefined;
    const value = mergeValue(inheritedValue, overrideValue);
    if (value !== REMOVED) mergedEntries.push([key, value]);
  }
  return Object.fromEntries(mergedEntries);
};

const cloneValue = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneValue(child)]));
};

export const mergeWorkflowConfig = (
  defaults: Record<string, unknown>,
  override: Record<string, unknown>
): Record<string, unknown> => mergeValue(defaults, override) as Record<string, unknown>;

export const resolveWorkflowStepConfig = (input: {
  baseConfig: Record<string, unknown>;
  configOverride?: unknown;
  configSchema: ZodType;
  maxAttempts?: number;
  path: string;
  timeoutMs?: number;
}): Record<string, unknown> => {
  const configOverride = input.configOverride ?? {};
  if (!isRecord(configOverride) || isUnsetConfigValue(configOverride)) {
    throw new Error(`${input.path} must be an object.`);
  }
  const resolved = mergeWorkflowConfig(input.baseConfig, configOverride);
  if (input.maxAttempts !== undefined) resolved.maxAttempts = input.maxAttempts;
  if (input.timeoutMs !== undefined) resolved.timeoutMs = input.timeoutMs;
  const parsed = input.configSchema.parse(resolved);
  assertWorkflowExecutionDefaults(parsed, input.path);
  return parsed as unknown as Record<string, unknown>;
};

export const WorkflowExecutionDefaultsSchema = z.object({
  maxAttempts: z.number().int().positive().max(POSTGRES_INTEGER_MAX),
  timeoutMs: z.number().int().positive().max(POSTGRES_INTEGER_MAX),
});

export const assertWorkflowExecutionDefaults: (
  value: unknown,
  path: string
) => asserts value is WorkflowExecutionDefaults = (
  value: unknown,
  path: string
): asserts value is WorkflowExecutionDefaults => {
  if (!isRecord(value)) throw new Error(`${path} must be an object.`);
  for (const key of ['maxAttempts', 'timeoutMs'] as const) {
    const setting = value[key];
    if (
      typeof setting !== 'number' ||
      !Number.isSafeInteger(setting) ||
      setting < 1 ||
      setting > POSTGRES_INTEGER_MAX
    ) {
      throw new Error(`${path}.${key} must be a positive PostgreSQL integer.`);
    }
  }
};
