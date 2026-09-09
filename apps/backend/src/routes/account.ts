import { AccountPreferencesSchema, EMPTY_ACCOUNT_PREFERENCES } from '@shared/accountPreferences.js';
import { FinishAccountSetupSchema } from '@shared/accountSetup.js';
import { Router } from 'express';
import { type AccountStore, getAccountStore } from '../account/accountStore.js';
import {
  hasCostEstimateCandidates,
  loadCurrentModelPrices,
  type ModelPrice,
  summarizeAccountUsage,
} from '../account/accountUsage.js';
import { getCurrentUser } from '../auth/currentUser.js';
import { createWorkflowAsyncRoute } from './workflows.js';

export const createAccountRouter = (
  store: () => AccountStore = getAccountStore,
  loadPrices: (signal: AbortSignal) => Promise<ModelPrice[]> = loadCurrentModelPrices
): Router => {
  const router = Router();
  const asyncRoute = createWorkflowAsyncRoute(() => false);
  router.get(
    '/usage',
    asyncRoute(async (request, response) => {
      response.set('Cache-Control', 'private, no-store');
      const controller = new AbortController();
      response.once('close', () => {
        if (!response.writableFinished) controller.abort();
      });
      const groups = await store().readUsage(getCurrentUser(request).id);
      if (controller.signal.aborted) return;
      let prices: ModelPrice[] = [];
      let ratesCheckedAt: string | null = null;
      if (request.query.estimate === 'true' && hasCostEstimateCandidates(groups)) {
        try {
          prices = await loadPrices(controller.signal);
          ratesCheckedAt = new Date().toISOString();
        } catch (error) {
          if (!controller.signal.aborted)
            console.error('[Account] Current token pricing unavailable.', error);
        }
        if (controller.signal.aborted) return;
      }
      return response.json(summarizeAccountUsage(groups, prices, ratesCheckedAt));
    })
  );
  router.use((_request, response, next) => {
    response.set('Cache-Control', 'private, no-store');
    next();
  });
  router.get(
    '/preferences',
    asyncRoute(async (request, response) => {
      const preferences = await store().readPreferences(getCurrentUser(request).id);
      return response.json({ preferences });
    })
  );
  router.get(
    '/setup',
    asyncRoute(async (request, response) => {
      return response.json({ status: await store().readSetupStatus(getCurrentUser(request).id) });
    })
  );
  router.put(
    '/setup',
    asyncRoute(async (request, response) => {
      const parsed = FinishAccountSetupSchema.safeParse(request.body);
      if (!parsed.success)
        return response
          .status(400)
          .json({ code: 'account_setup_invalid', error: 'Preferenze non valide.' });
      await store().finishSetup(getCurrentUser(request).id, parsed.data);
      return response.json({ status: parsed.data.status });
    })
  );
  router.put(
    '/preferences',
    asyncRoute(async (request, response) => {
      const parsed = AccountPreferencesSchema.safeParse(request.body);
      if (!parsed.success)
        return response.status(400).json({
          code: 'account_preferences_invalid',
          error: 'Preferenze non valide.',
        });
      const preferences = await store().savePreferences(getCurrentUser(request).id, parsed.data);
      return response.json({ preferences });
    })
  );
  router.delete(
    '/preferences',
    asyncRoute(async (request, response) => {
      await store().clearPreferences(getCurrentUser(request).id);
      return response.json({ preferences: EMPTY_ACCOUNT_PREFERENCES });
    })
  );
  return router;
};
