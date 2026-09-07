import { expect, test } from 'vitest';
import { readLibraryExportConfig } from '../../src/projects/libraryExportConfig.js';

test('uses the approved provisional defaults and accepts explicit overrides', () => {
  expect(readLibraryExportConfig({})).toEqual({
    executionsGlobal: 1,
    retentionMs: 86_400_000,
    cleanupIntervalMs: 900_000,
  });
  expect(
    readLibraryExportConfig({
      LIBRARY_EXPORT_EXECUTIONS_GLOBAL: '3',
      LIBRARY_EXPORT_RETENTION_MS: '7200000',
      LIBRARY_EXPORT_CLEANUP_INTERVAL_MS: '60000',
    })
  ).toEqual({ executionsGlobal: 3, retentionMs: 7_200_000, cleanupIntervalMs: 60_000 });
  expect(readLibraryExportConfig({ LIBRARY_EXPORT_EXECUTIONS_GLOBAL: '' }).executionsGlobal).toBe(
    1
  );
});

test('rejects intervals that the runtime would clamp to one millisecond', () => {
  const maximumTimerDelayMs = 2 ** 31 - 1;
  expect(
    readLibraryExportConfig({ LIBRARY_EXPORT_CLEANUP_INTERVAL_MS: String(maximumTimerDelayMs) })
      .cleanupIntervalMs
  ).toBe(maximumTimerDelayMs);
  expect(() =>
    readLibraryExportConfig({ LIBRARY_EXPORT_CLEANUP_INTERVAL_MS: String(maximumTimerDelayMs + 1) })
  ).toThrow('LIBRARY_EXPORT_CLEANUP_INTERVAL_MS');
});

test('rejects retention that cannot produce a valid expiration date', () => {
  expect(() =>
    readLibraryExportConfig({ LIBRARY_EXPORT_RETENTION_MS: String(Number.MAX_SAFE_INTEGER) })
  ).toThrow('LIBRARY_EXPORT_RETENTION_MS');
});

test.each([
  '0',
  '-1',
  '1.5',
  '3workers',
  'NaN',
  '9007199254740992',
])('rejects invalid export policy value %s', value => {
  for (const key of [
    'LIBRARY_EXPORT_EXECUTIONS_GLOBAL',
    'LIBRARY_EXPORT_RETENTION_MS',
    'LIBRARY_EXPORT_CLEANUP_INTERVAL_MS',
  ]) {
    expect(() => readLibraryExportConfig({ [key]: value })).toThrow(key);
  }
});
