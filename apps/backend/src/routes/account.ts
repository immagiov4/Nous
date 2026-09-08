import { AccountPreferencesSchema, EMPTY_ACCOUNT_PREFERENCES } from '@shared/accountPreferences.js';
import { Router } from 'express';
import { type AccountStore, getAccountStore } from '../account/accountStore.js';
import {
  loadCurrentModelPrices,
  type ModelPrice,
  summarizeAccountUsage,
} from '../account/accountUsage.js';
import { getCurrentUser } from '../auth/currentUser.js';
import { createWorkflowAsyncRoute } from './workflows.js';

export const createAccountRouter = (
  store: () => AccountStore = getAccountStore,
  loadPrices: () => Promise<ModelPrice[]> = loadCurrentModelPrices
): Router => {
  const router = Router();
  const asyncRoute = createWorkflowAsyncRoute(() => false);
  router.get(
    '/usage',
    asyncRoute(async (request, response) => {
      response.set('Cache-Control', 'private, no-store');
      const groups = await store().readUsage(getCurrentUser(request).id);
      let prices: ModelPrice[] = [];
      let ratesCheckedAt: string | null = null;
      if (groups.some(group => group.provider === 'openrouter' && group.reportedCostUsd === null)) {
        try {
          prices = await loadPrices();
          ratesCheckedAt = new Date().toISOString();
        } catch (error) {
          console.error('[Account] Current token pricing unavailable.', error);
        }
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
