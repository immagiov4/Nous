import * as z from 'zod';
import { AccountPreferencesSchema } from './accountPreferences';

export const AccountSetupStatusSchema = z.enum(['pending', 'completed', 'skipped', 'not-required']);
export type AccountSetupStatus = z.infer<typeof AccountSetupStatusSchema>;
export const FinishAccountSetupSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('completed'), preferences: AccountPreferencesSchema }).strict(),
  z.object({ status: z.literal('skipped') }).strict(),
]);
export type FinishAccountSetup = z.infer<typeof FinishAccountSetupSchema>;
