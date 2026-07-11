import type { Request } from 'express';

import { getCurrentUser } from '../auth/currentUser.js';
import { isCodexAppServerEnabled } from './codexAppServer.js';

export const CODEX_ACCESS_DENIED_MESSAGE = 'Codex non è disponibile per questo account.';

export class CodexAccessError extends Error {
  constructor() {
    super(CODEX_ACCESS_DENIED_MESSAGE);
    this.name = 'CodexAccessError';
  }
}

export const isLoopbackAddress = (address: string | undefined): boolean => {
  const normalizedAddress = address?.toLowerCase().split('%', 1)[0];
  return (
    normalizedAddress === '::1' ||
    normalizedAddress?.startsWith('127.') === true ||
    normalizedAddress?.startsWith('::ffff:127.') === true
  );
};

export const isLoopbackHost = (hostname: string): boolean =>
  hostname.toLowerCase() === 'localhost' || isLoopbackAddress(hostname.replace(/^\[|\]$/g, ''));

export const assertCodexRequestAccess = (req: Request): void => {
  const ownerUserId = process.env.CODEX_OWNER_USER_ID?.trim();
  const currentUser = getCurrentUser(req);
  if (
    !isCodexAppServerEnabled() ||
    !ownerUserId ||
    currentUser.id !== ownerUserId ||
    !isLoopbackAddress(req.socket.remoteAddress) ||
    !isLoopbackHost(req.hostname)
  ) {
    throw new CodexAccessError();
  }
};
