import { describe, expect, test } from 'vitest';
import { getErrorDiagnostic } from '../../../services/core/errorMessage.ts';

describe('error diagnostics', () => {
  test('preserves useful fields from nested errors', () => {
    const error = new Error('Preview SVG non riuscita.', {
      cause: new Error('Impossibile caricare il blob.'),
    });

    expect(getErrorDiagnostic(error)).toMatchObject({
      cause: 'Error: Impossibile caricare il blob.',
      message: 'Preview SVG non riuscita.',
      name: 'Error',
      stack: expect.stringContaining('Preview SVG non riuscita.'),
    });
  });
});
