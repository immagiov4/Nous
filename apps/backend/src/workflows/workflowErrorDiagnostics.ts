import { APICallError } from 'ai';
import {
  type GlobalModelConfig,
  isAiProvider,
  isTextModelSlot,
  resolveAiProviderForSlot,
  resolveCodexServiceTierForSlot,
  resolveTextModelConfig,
  type TextModelSlot,
} from '../config/modelConfig.js';
import { sanitizeDiagnosticText } from '../utils/sanitizeDiagnosticText.js';
import { isRecord } from '../utils/validation.js';
import type { JsonValue } from './types.js';

const MAX_ERROR_CAUSE_DEPTH = 3;
const MAX_TECHNICAL_IDENTIFIER_LENGTH = 128;
const DIAGNOSTIC_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u;
const TECHNICAL_IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]*$/u;
const MODEL_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u;

export type WorkflowErrorDiagnostic = Readonly<Record<string, JsonValue>>;
export type WorkflowModelDiagnostic = Readonly<Record<string, JsonValue>>;
type DiagnosticCode = number | string;

const readTechnicalIdentifier = (value: unknown): string | undefined =>
  typeof value === 'string' &&
  value.length <= MAX_TECHNICAL_IDENTIFIER_LENGTH &&
  TECHNICAL_IDENTIFIER_PATTERN.test(value)
    ? value
    : undefined;

const readDiagnosticCode = (value: unknown): DiagnosticCode | undefined => {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
  }
  return typeof value === 'string' &&
    value.length <= MAX_TECHNICAL_IDENTIFIER_LENGTH &&
    DIAGNOSTIC_CODE_PATTERN.test(value)
    ? value
    : undefined;
};

const readModelIdentifier = (value: unknown): string | undefined =>
  typeof value === 'string' &&
  value.length <= MAX_TECHNICAL_IDENTIFIER_LENGTH &&
  MODEL_IDENTIFIER_PATTERN.test(value)
    ? value
    : undefined;

const readDiagnosticMessage = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  return sanitizeDiagnosticText(value, MAX_TECHNICAL_IDENTIFIER_LENGTH) || undefined;
};

interface ProviderDiagnosticFields {
  readonly code?: DiagnosticCode;
  readonly parameter?: string;
  readonly providerCode?: DiagnosticCode;
  readonly providerErrorType?: string;
}

const readThrownProviderFields = (value: unknown): ProviderDiagnosticFields => {
  if (!APICallError.isInstance(value) || !isRecord(value.data)) return {};
  const providerError = isRecord(value.data.error) ? value.data.error : value.data;
  const metadata = isRecord(providerError.metadata) ? providerError.metadata : {};
  const code = readDiagnosticCode(providerError.code);
  const parameter = readTechnicalIdentifier(providerError.param);
  const providerCode = readDiagnosticCode(metadata.provider_code);
  const providerErrorType = readTechnicalIdentifier(
    metadata.error_type ?? providerError.error_type ?? providerError.type
  );
  return {
    ...(code === undefined ? {} : { code }),
    ...(parameter ? { parameter } : {}),
    ...(providerCode === undefined ? {} : { providerCode }),
    ...(providerErrorType ? { providerErrorType } : {}),
  };
};

const readPersistedProviderFields = (value: Record<string, unknown>): ProviderDiagnosticFields => {
  const parameter = readTechnicalIdentifier(value.parameter);
  const providerCode = readDiagnosticCode(value.providerCode);
  const providerErrorType = readTechnicalIdentifier(value.providerErrorType);
  return {
    ...(parameter ? { parameter } : {}),
    ...(providerCode === undefined ? {} : { providerCode }),
    ...(providerErrorType ? { providerErrorType } : {}),
  };
};

const providerDiagnosticMessage = (fields: ProviderDiagnosticFields): string | undefined => {
  const reason = fields.providerErrorType ?? fields.providerCode ?? fields.code;
  return reason === undefined ? undefined : `Provider error: ${reason}.`;
};

const readStatus = (record: Record<string, unknown>): number | undefined => {
  const status = record.status ?? record.statusCode;
  return typeof status === 'number' && Number.isSafeInteger(status) && status >= 0
    ? status
    : undefined;
};

const errorType = (error: Record<string, unknown>): string => {
  const declared = readTechnicalIdentifier(error.name);
  if (declared) return declared;
  return error instanceof Error ? 'Error' : 'UnknownError';
};

const safeProviderDiagnosticMessage = (
  type: string,
  code: DiagnosticCode | undefined,
  providerFields: ProviderDiagnosticFields
): string | undefined =>
  providerDiagnosticMessage(
    type === 'AI_APICallError' && code !== undefined ? { ...providerFields, code } : providerFields
  );

const readProjectedMessage = (input: {
  depth: number;
  persisted: boolean;
  providerMessage: string | undefined;
  storedMessage: unknown;
  trustedMessage: string | undefined;
}): string | undefined => {
  if (input.depth !== 1) return input.providerMessage;
  if (input.persisted) return readDiagnosticMessage(input.storedMessage);
  return readDiagnosticMessage(input.trustedMessage) ?? input.providerMessage;
};

const createDiagnosticProjection = (input: {
  cause: WorkflowErrorDiagnostic | undefined;
  code: DiagnosticCode | undefined;
  message: string | undefined;
  providerFields: ProviderDiagnosticFields;
  status: number | undefined;
  type: string;
}): WorkflowErrorDiagnostic => ({
  ...(input.cause ? { cause: input.cause } : {}),
  ...(input.code === undefined ? {} : { code: input.code }),
  ...(input.message ? { message: input.message } : {}),
  ...(input.providerFields.parameter ? { parameter: input.providerFields.parameter } : {}),
  ...(input.providerFields.providerCode === undefined
    ? {}
    : { providerCode: input.providerFields.providerCode }),
  ...(input.providerFields.providerErrorType
    ? { providerErrorType: input.providerFields.providerErrorType }
    : {}),
  ...(input.status === undefined ? {} : { status: input.status }),
  type: input.type,
});

const createDiagnostic = (
  value: unknown,
  depth: number,
  persisted: boolean,
  trustedMessage?: string
): WorkflowErrorDiagnostic | undefined => {
  if (!isRecord(value)) return persisted ? undefined : { type: 'UnknownError' };
  const type = readTechnicalIdentifier(persisted ? value.type : errorType(value));
  if (!type) return undefined;
  const providerFields = persisted
    ? readPersistedProviderFields(value)
    : readThrownProviderFields(value);
  const code = readDiagnosticCode(value.code) ?? providerFields.code;
  const providerMessage = safeProviderDiagnosticMessage(type, code, providerFields);
  const message = readProjectedMessage({
    depth,
    persisted,
    providerMessage,
    storedMessage: value.message,
    trustedMessage,
  });
  const status = readStatus(value);
  const cause =
    depth < MAX_ERROR_CAUSE_DEPTH && value.cause !== undefined
      ? createDiagnostic(value.cause, depth + 1, persisted)
      : undefined;
  return createDiagnosticProjection({
    cause,
    code,
    message,
    providerFields,
    status,
    type,
  });
};

/** Projects a thrown value onto a bounded allowlist suitable for durable private diagnostics. */
export const toWorkflowErrorDiagnostic = (
  error: unknown,
  options: { trustedMessage?: string } = {}
): WorkflowErrorDiagnostic =>
  createDiagnostic(error, 1, false, options.trustedMessage) ?? { type: 'UnknownError' };

/** Revalidates stored diagnostics before they cross into structured operational logs. */
export const readWorkflowErrorDiagnostic = (value: unknown): WorkflowErrorDiagnostic | undefined =>
  createDiagnostic(value, 1, true);

/** Resolves the exact provider/model choice without retaining the surrounding secret-bearing config. */
export const createWorkflowModelDiagnostic = (
  config: GlobalModelConfig,
  slot: TextModelSlot
): WorkflowModelDiagnostic => {
  const provider = resolveAiProviderForSlot(config, slot);
  const serviceTier =
    provider === 'codex' ? resolveCodexServiceTierForSlot(config, slot) : undefined;
  return {
    model: resolveTextModelConfig(config, slot).model,
    provider,
    ...(serviceTier ? { serviceTier } : {}),
    slot,
  };
};

/** Revalidates the persisted model projection before exposing it to operational logs. */
export const readWorkflowModelDiagnostic = (
  value: unknown
): WorkflowModelDiagnostic | undefined => {
  if (!isRecord(value)) return undefined;
  const model = readModelIdentifier(value.model);
  const provider = value.provider;
  const slot = value.slot;
  if (!model || !isAiProvider(provider) || !isTextModelSlot(slot)) {
    return undefined;
  }
  if (value.serviceTier !== undefined && value.serviceTier !== 'fast') return undefined;
  return {
    model,
    provider,
    ...(value.serviceTier === 'fast' ? { serviceTier: value.serviceTier } : {}),
    slot,
  };
};
