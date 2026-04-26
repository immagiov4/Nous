import type { NextFunction, Request, Response } from 'express';

const DEFAULT_LOCAL_USER_ID = 'local-user';

export interface CurrentUser {
  id: string;
}

export interface RequestWithCurrentUser extends Request {
  currentUser: CurrentUser;
}

const isLocalAuthBypassEnabled = (): boolean => process.env.LOCAL_AUTH_BYPASS !== 'false';

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
    error: 'Authentication is not configured for this deployment.',
  });
};

export const getCurrentUser = (req: Request): CurrentUser => {
  const currentUser = (req as RequestWithCurrentUser).currentUser;
  if (!currentUser) {
    throw new Error('Current user was not resolved before accessing project storage.');
  }

  return currentUser;
};
