// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  clearFeedbackDiagnostics,
  getFeedbackDiagnosticsSnapshot,
  initializeFeedbackDiagnostics,
  logBackendFailureCorrelationId,
  sanitizeFeedbackDiagnosticText,
} from '../../../services/feedback/browserDiagnostics.ts';

describe('browser feedback diagnostics', () => {
  let cleanup: () => void;

  beforeEach(() => {
    clearFeedbackDiagnostics();
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    globalThis.history.replaceState({}, '', '/course/123?access_token=page-secret#lesson');
    cleanup = initializeFeedbackDiagnostics();
  });

  afterEach(() => {
    cleanup();
    clearFeedbackDiagnostics();
    vi.restoreAllMocks();
  });

  test('keeps a bounded, sanitized buffer without collecting unrelated console content', () => {
    console.info('third-party message with student@example.com');
    console.error(
      '[Nous][API] request failed',
      'email=student@example.com access_token=super-secret',
      { courseText: 'private lesson content' }
    );
    console.info('[Nous] Codice assistenza: 123e4567-e89b-12d3-a456-426614174000');
    for (let index = 0; index < 90; index += 1) console.info(`[Nous] event ${index}`);

    const snapshot = getFeedbackDiagnosticsSnapshot();

    expect(snapshot.pageUrl).toBe('http://localhost:3000/course/123');
    expect(snapshot.consoleEntries).toHaveLength(80);
    expect(snapshot.consoleEntries.some(entry => entry.message.includes('third-party'))).toBe(
      false
    );
    expect(
      snapshot.consoleEntries.some(entry => entry.message.includes('student@example.com'))
    ).toBe(false);
    expect(snapshot.consoleEntries.some(entry => entry.message.includes('super-secret'))).toBe(
      false
    );
    expect(
      snapshot.consoleEntries.some(entry => entry.message.includes('private lesson content'))
    ).toBe(false);
  });

  test('records uncaught browser errors without URL parameters', () => {
    globalThis.dispatchEvent(
      new ErrorEvent('error', {
        filename: 'https://nous.test/assets/app.js?token=secret',
        lineno: 42,
        message: 'Rendering failed for student@example.com',
      })
    );

    expect(getFeedbackDiagnosticsSnapshot().consoleEntries).toEqual([
      expect.objectContaining({
        level: 'error',
        message:
          'Errore non gestito: Rendering failed for [EMAIL RIMOSSA] (https://nous.test/assets/app.js:42)',
      }),
    ]);
  });

  test('records validated backend support codes in feedback diagnostics', () => {
    const correlationId = '123e4567-e89b-42d3-a456-426614174000';

    logBackendFailureCorrelationId(correlationId);
    logBackendFailureCorrelationId('private-invalid-value');

    expect(getFeedbackDiagnosticsSnapshot()).toMatchObject({
      correlationIds: [correlationId],
      consoleEntries: [
        {
          level: 'warn',
          message: `[Nous][API] Codice assistenza: ${correlationId}`,
        },
      ],
    });
  });

  test('retains the most recent unique backend support codes', () => {
    const correlationIds = Array.from(
      { length: 11 },
      (_, index) => `123e4567-e89b-42d3-a456-${String(index).padStart(12, '0')}`
    );
    for (const correlationId of correlationIds) logBackendFailureCorrelationId(correlationId);

    expect(getFeedbackDiagnosticsSnapshot().correlationIds).toEqual(
      correlationIds.slice(-10).reverse()
    );
  });

  test('preserves diagnostics across observer teardown until explicitly cleared', () => {
    console.error('[Nous] multi-step failure correlation 123e4567-e89b-12d3-a456-426614174000');
    cleanup();
    expect(getFeedbackDiagnosticsSnapshot().consoleEntries).toHaveLength(1);

    cleanup = initializeFeedbackDiagnostics();
    expect(getFeedbackDiagnosticsSnapshot().consoleEntries[0]?.message).toContain(
      'multi-step failure'
    );

    clearFeedbackDiagnostics();
    expect(getFeedbackDiagnosticsSnapshot().consoleEntries).toHaveLength(0);
  });

  test('redacts quoted and unquoted credential fields', () => {
    expect(sanitizeFeedbackDiagnosticText('"api_key":"secret-value" password=another-secret')).toBe(
      '"api_key=[RIMOSSO] password=[RIMOSSO]'
    );
    expect(sanitizeFeedbackDiagnosticText("access_token='quoted-secret'")).toBe(
      'access_token=[RIMOSSO]'
    );
  });

  test('never lets hostile console arguments break the observed application call', () => {
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const hostileError = Object.create(Error.prototype, {
      name: {
        get: () => {
          throw new Error('getter must not escape');
        },
      },
    });

    expect(() =>
      console.error('[Nous] hostile diagnostics', revoked.proxy, hostileError)
    ).not.toThrow();
    expect(getFeedbackDiagnosticsSnapshot().consoleEntries.at(-1)?.message).toContain(
      '[Dati non leggibili]'
    );
  });
});
