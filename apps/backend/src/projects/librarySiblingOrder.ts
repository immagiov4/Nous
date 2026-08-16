const LIBRARY_SIBLING_SET_CHANGED_MESSAGE = 'Library sibling set changed during reorder.';
export const LIBRARY_SIBLING_CONFLICT_MESSAGE =
  'La libreria è stata modificata in un’altra sessione. Riprova.';

export class LibrarySiblingSetChangedError extends Error {
  constructor() {
    super(LIBRARY_SIBLING_SET_CHANGED_MESSAGE);
    this.name = 'LibrarySiblingSetChangedError';
  }
}
