import type { Request } from 'express';

import { getCurrentUser } from '../auth/currentUser.js';
import { getGlobalModelConfig } from '../config/modelConfig.js';
import { isCodexAppServerEnabled } from './codexAppServer.js';

export const CODEX_ACCESS_DENIED_MESSAGE = 'Codex non è disponibile per questo account.';

export class CodexAccessError extends Error {
  constructor() {
    super(CODEX_ACCESS_DENIED_MESSAGE);
    this.name = 'CodexAccessError';
  }
}

export const assertCodexRequestAccess = (req: Request): void => {
  const currentUser = getCurrentUser(req);
  const globalConfig = getGlobalModelConfig();
  const assignedProvider = currentUser.aiProvider || globalConfig.aiProvider;
  const assignedOverrides = currentUser.aiProvider
    ? currentUser.aiProviderOverrides
    : { ...globalConfig.aiProviderOverrides, ...currentUser.aiProviderOverrides };
  const hasCodexProvider =
    assignedProvider === 'codex' || Object.values(assignedOverrides || {}).includes('codex');
  if (!isCodexAppServerEnabled() || (currentUser.role !== 'admin' && !hasCodexProvider)) {
    throw new CodexAccessError();
  }
};
