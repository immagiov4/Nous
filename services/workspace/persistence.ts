import { AppState, type WorkspaceDomainState } from '../../types.ts';

export const resolvePersistedAppState = (domainState: WorkspaceDomainState): AppState => {
  if (domainState.learningPlan || domainState.laboratory) {
    return AppState.READING;
  }

  if (domainState.source) {
    return AppState.ASSESSMENT;
  }

  return AppState.LIBRARY;
};
