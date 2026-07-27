export const PROJECT_REVISION_CONFLICT_MESSAGE =
  "Il progetto è stato modificato in un'altra sessione. Ricaricalo prima di salvare.";

export class ProjectRevisionConflictError extends Error {
  constructor() {
    super(PROJECT_REVISION_CONFLICT_MESSAGE);
    this.name = 'ProjectRevisionConflictError';
  }
}
