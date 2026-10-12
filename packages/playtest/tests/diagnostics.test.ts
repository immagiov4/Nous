import { describe, expect, it, vi } from 'vitest';
import { type DiagnosticRecord, recordDiagnostic, withDiagnostics } from '../src/diagnostics';

describe('diagnostic scopes', () => {
  it('retains causes and repeated failures while isolating parallel stories from their run', async () => {
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
    const run: DiagnosticRecord = {};
    const first: DiagnosticRecord = {};
    const second: DiagnosticRecord = {};
    try {
      await withDiagnostics(run, async () => {
        recordDiagnostic('stack', new Error('Run cause'));
        const missingMessageInStack = new Error('Retained message');
        missingMessageInStack.stack = 'Error\n    at synthetic';
        recordDiagnostic('inspection', missingMessageInStack);
        await Promise.all([
          withDiagnostics(first, async () => {
            await Promise.resolve();
            recordDiagnostic(
              'decision',
              new Error('First cause', { cause: new Error('Provider detail') })
            );
            recordDiagnostic('decision', new Error('Another cause'));
          }),
          withDiagnostics(second, async () => {
            recordDiagnostic('decision', new Error('Second cause'));
          }),
        ]);
      });
      expect(run.diagnostics?.stack).toContain('Run cause');
      expect(run.diagnostics?.inspection).toContain('Retained message');
      expect(run.diagnostics?.decision).toBeUndefined();
      expect(first.diagnostics?.decision).toContain('Provider detail');
      expect(first.diagnostics?.decision).toContain('Another cause');
      expect(first.diagnostics?.decision).not.toContain('Second cause');
      expect(second.diagnostics?.decision).toContain('Second cause');
      expect(stderr).toHaveBeenCalledTimes(5);
    } finally {
      stderr.mockRestore();
    }
  });
});
