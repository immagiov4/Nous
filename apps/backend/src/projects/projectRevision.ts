import { PROJECT_API_ERROR_CODE } from '@shared/projectContract';

export const PROJECT_REVISION_CONFLICT_MESSAGE =
  "Il progetto è stato modificato in un'altra sessione. Ricaricalo prima di salvare.";
export const PROJECT_NOT_FOUND_MESSAGE = 'Il corso non esiste più.';

export class ProjectRevisionConflictError extends Error {
  readonly code = PROJECT_API_ERROR_CODE.revisionConflict;

  constructor() {
    super(PROJECT_REVISION_CONFLICT_MESSAGE);
    this.name = 'ProjectRevisionConflictError';
  }
}

export class ProjectNotFoundError extends Error {
  constructor() {
    super(PROJECT_NOT_FOUND_MESSAGE);
    this.name = 'ProjectNotFoundError';
  }
}
