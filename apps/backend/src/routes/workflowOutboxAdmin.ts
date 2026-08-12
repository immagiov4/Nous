import { type NextFunction, type Request, type Response, Router } from 'express';
import * as z from 'zod';

import { getCurrentUser } from '../auth/currentUser.js';
import type { PostgresWorkflowOutboxStore } from '../workflows/postgresWorkflowOutboxStore.js';

const ADMIN_REQUIRED_RESPONSE = {
  error: 'Solo un amministratore puo eseguire questa operazione.',
  success: false,
} as const;
const DEAD_LETTER_NOT_FOUND_RESPONSE = {
  error: 'Evento non trovato tra quelli da riesaminare.',
  success: false,
} as const;
const INVALID_REQUEST_RESPONSE = {
  error: 'Richiesta non valida.',
  success: false,
} as const;
const routeParametersSchema = z.object({ id: z.uuid() });

export type WorkflowOutboxAdmin = Pick<
  PostgresWorkflowOutboxStore,
  'listDeadLetters' | 'retryDeadLetter'
>;

const requireAdminUser = (request: Request, response: Response, next: NextFunction): void => {
  if (getCurrentUser(request).role === 'admin') {
    next();
    return;
  }
  response.status(403).json(ADMIN_REQUIRED_RESPONSE);
};

export const createWorkflowOutboxAdminRouter = (outbox: WorkflowOutboxAdmin): Router => {
  const router = Router();
  router.use(requireAdminUser);

  router.get('/dead-letters', async (_request, response) => {
    const deadLetters = await outbox.listDeadLetters();
    response.json({ deadLetters, success: true });
  });

  router.post('/dead-letters/:id/retry', async (request, response) => {
    const parameters = routeParametersSchema.safeParse(request.params);
    if (!parameters.success) {
      response.status(400).json(INVALID_REQUEST_RESPONSE);
      return;
    }
    const retried = await outbox.retryDeadLetter({
      id: parameters.data.id,
      requestedBy: getCurrentUser(request).id,
    });
    if (!retried) {
      response.status(404).json(DEAD_LETTER_NOT_FOUND_RESPONSE);
      return;
    }
    response.json({ success: true });
  });

  return router;
};
