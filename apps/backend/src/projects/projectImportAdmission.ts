import type { NextFunction, Request, Response } from 'express';

import { getCurrentUser } from '../auth/currentUser.js';

const MAX_IN_FLIGHT_IMPORT_REQUESTS_PER_USER = 1;
const MAX_IN_FLIGHT_IMPORT_REQUESTS_GLOBAL = 3;

const inFlightByUser = new Map<string, number>();
let inFlightGlobal = 0;

export const admitProjectImportRequest = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  const userId = getCurrentUser(req).id;
  const inFlightForUser = inFlightByUser.get(userId) || 0;
  if (
    inFlightForUser >= MAX_IN_FLIGHT_IMPORT_REQUESTS_PER_USER ||
    inFlightGlobal >= MAX_IN_FLIGHT_IMPORT_REQUESTS_GLOBAL
  ) {
    req.resume();
    res.status(429).json({
      success: false,
      error: 'Ci sono troppe parti del backup in trasferimento. Riprova tra poco.',
    });
    return;
  }

  inFlightByUser.set(userId, inFlightForUser + 1);
  inFlightGlobal += 1;
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    const remainingForUser = (inFlightByUser.get(userId) || 1) - 1;
    if (remainingForUser > 0) inFlightByUser.set(userId, remainingForUser);
    else inFlightByUser.delete(userId);
    inFlightGlobal = Math.max(0, inFlightGlobal - 1);
  };
  res.once('finish', release);
  res.once('close', release);
  next();
};
