import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { setRenderingLocaleOverride } from '../../../i18n/uiMessages.ts';
import { formatSourceWarningSummary } from '../../../services/projects/sourceWarningSummary.ts';
import type { ProjectSourceWarning } from '../../../types.ts';

beforeEach(() => setRenderingLocaleOverride('it'));
afterEach(() => setRenderingLocaleOverride(null));

describe('formatSourceWarningSummary', () => {
  test('groups PDF reasons, sorts paths, and bounds representative details', () => {
    const longPath = `c/${'cartella/'.repeat(12)}documento.pdf`;
    const warnings: ProjectSourceWarning[] = [
      { message: 'timeout', name: 'z/timeout.pdf', reason: 'timeout' },
      { message: 'quality', name: longPath, reason: 'no-usable-text' },
      { message: 'limit', name: 'm/large.pdf', reason: 'safety-limit' },
      { message: 'parser', name: 'b/unreadable.pdf', reason: 'parser-failed' },
      { message: 'quality', name: 'a/scanned.pdf', reason: 'no-usable-text' },
    ];

    const summary = formatSourceWarningSummary(warnings);

    expect(summary).toContain(
      '5 PDF non usati: 2 senza testo utile, 1 non leggibili, 1 oltre i limiti, 1 scaduti.'
    );
    expect(summary).toContain('Esempi: a/scanned.pdf; b/unreadable.pdf; c/cartella/');
    expect(summary).toContain('…');
    expect(summary).toContain('Altri 2 non mostrati.');
    expect(summary).toMatch(/Il corso continua con le fonti valide\.$/u);
    expect(warnings[1]?.name).toBe(longPath);
  });

  test('shows every PDF path when there are at most three warnings', () => {
    const summary = formatSourceWarningSummary([
      { message: 'quality', name: 'b.pdf', reason: 'no-usable-text' },
      { message: 'timeout', name: 'a.pdf', reason: 'timeout' },
    ]);

    expect(summary).toContain('Esempi: a.pdf; b.pdf.');
    expect(summary).not.toContain('non mostrati');
  });

  test('preserves the existing summary for non-archive source warnings', () => {
    expect(
      formatSourceWarningSummary([
        { message: 'invalid', name: 'scansione.pdf' },
        { message: 'empty', name: 'vuoto.pdf' },
      ])
    ).toBe(
      'Alcune fonti non sono state usate: scansione.pdf, vuoto.pdf. Il corso continua con le altre.'
    );
  });
});
