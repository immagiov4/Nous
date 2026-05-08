import { describe, expect, it } from 'vitest';
import {
  EXERCISE_PASS_THRESHOLD,
  EXERCISE_MAX_ENTRIES,
  EXERCISE_MAX_TOTAL_CHARS,
  EXERCISE_MAX_ENTRY_CHARS,
  EXERCISE_TEXT_EXTENSION_ALLOWLIST,
  EXERCISE_ZIP_IGNORE_DIRS,
} from '../../../services/exercises/constants.ts';

describe('exercise constants', () => {
  it('threshold defaults to 60', () => {
    expect(EXERCISE_PASS_THRESHOLD).toBe(60);
  });

  it('budget constants match spec', () => {
    expect(EXERCISE_MAX_ENTRIES).toBe(10);
    expect(EXERCISE_MAX_TOTAL_CHARS).toBe(50_000);
    expect(EXERCISE_MAX_ENTRY_CHARS).toBe(20_000);
  });

  it('text allowlist includes core text formats and code extensions', () => {
    for (const ext of ['.md', '.txt', '.json', '.ts', '.tsx', '.py', '.go']) {
      expect(EXERCISE_TEXT_EXTENSION_ALLOWLIST.has(ext)).toBe(true);
    }
    expect(EXERCISE_TEXT_EXTENSION_ALLOWLIST.has('.png')).toBe(false);
  });

  it('zip ignore set covers common build/cache dirs', () => {
    for (const dir of [
      'node_modules',
      'dist',
      'build',
      'target',
      '.next',
      '.cache',
      'coverage',
      '__pycache__',
    ]) {
      expect(EXERCISE_ZIP_IGNORE_DIRS.has(dir)).toBe(true);
    }
  });
});
