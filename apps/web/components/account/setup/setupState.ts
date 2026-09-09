import {
  type AccountPreferences,
  AccountPreferencesSchema,
  EMPTY_ACCOUNT_PREFERENCES,
} from '@shared/accountPreferences';

export const SETUP_STEPS = ['languages', 'preferences'] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];
export interface SetupState {
  hasLoaded: boolean;
  step: SetupStep;
  phase: 'loading' | 'load-error' | 'editing' | 'saving' | 'save-error' | 'completed' | 'skipped';
  draft: AccountPreferences;
}
export const initialSetupState: SetupState = {
  step: 'languages',
  phase: 'loading',
  draft: EMPTY_ACCOUNT_PREFERENCES,
  hasLoaded: false,
};
export type SetupEvent =
  | { type: 'loaded'; preferences: AccountPreferences }
  | { type: 'load-failed' | 'saving' | 'save-failed' | 'completed' | 'skipped' | 'reload' }
  | { type: 'change'; patch: Partial<AccountPreferences> }
  | { type: 'step'; step: SetupStep };

/** Transitions shared by account setup and its isolated demonstration. */
export function setupReducer(state: SetupState, event: SetupEvent): SetupState {
  switch (event.type) {
    case 'loaded':
      return { ...state, phase: 'editing', draft: event.preferences, hasLoaded: true };
    case 'reload':
      return { ...state, phase: 'loading' };
    case 'load-failed':
      return { ...state, phase: 'load-error' };
    case 'save-failed':
      return { ...state, phase: 'save-error' };
    case 'saving':
      return { ...state, phase: 'saving' };
    case 'completed':
      return { ...state, phase: 'completed' };
    case 'skipped':
      return { ...state, phase: 'skipped' };
    case 'change':
      if (state.phase !== 'editing' && state.phase !== 'save-error') return state;
      return { ...state, phase: 'editing', draft: { ...state.draft, ...event.patch } };
    case 'step':
      if (state.phase !== 'editing' && state.phase !== 'save-error') return state;
      if (
        !AccountPreferencesSchema.safeParse({
          ...state.draft,
          contentLanguage: state.draft.contentLanguage?.trim() || null,
        }).success &&
        SETUP_STEPS.indexOf(event.step) > SETUP_STEPS.indexOf(state.step)
      )
        return state;
      return { ...state, phase: 'editing', step: event.step };
  }
}
