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
  const assignedProvider = currentUser.aiProvider || getGlobalModelConfig().aiProvider;
  if (
    !isCodexAppServerEnabled() ||
    (currentUser.role !== 'admin' && assignedProvider !== 'codex')
  ) {
    throw new CodexAccessError();
  }
};
