import type { NextFunction, Request, Response } from 'express';

const DEFAULT_LOCAL_USER_ID = 'local-user';
export const LOCAL_AUTH_MODE = 'local-bypass' as const;

export interface CurrentUser {
  id: string;
}

export interface RequestWithCurrentUser extends Request {
  currentUser: CurrentUser;
}

const isLocalAuthBypassEnabled = (): boolean =>
  process.env.LOCAL_AUTH_BYPASS === 'true' || process.env.NODE_ENV === 'test';

export const resolveCurrentUser = (req: Request, res: Response, next: NextFunction): void => {
  if (isLocalAuthBypassEnabled()) {
    (req as RequestWithCurrentUser).currentUser = {
      id: process.env.LOCAL_USER_ID?.trim() || DEFAULT_LOCAL_USER_ID,
    };
    next();
    return;
  }

  res.status(401).json({
    success: false,
    error: 'Autenticazione non configurata per questa installazione.',
  });
};

export const getCurrentUser = (req: Request): CurrentUser => {
  const currentUser = (req as RequestWithCurrentUser).currentUser;
  if (!currentUser) {
    throw new Error('Current user was not resolved before accessing project storage.');
  }

  return currentUser;
};
