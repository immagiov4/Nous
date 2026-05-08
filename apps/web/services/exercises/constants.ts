export const EXERCISE_PASS_THRESHOLD = 60;
export const EXERCISE_MAX_ENTRIES = 10;
export const EXERCISE_MAX_TOTAL_CHARS = 50_000;
export const EXERCISE_MAX_ENTRY_CHARS = 20_000;

export const EXERCISE_TEXT_EXTENSION_ALLOWLIST: ReadonlySet<string> = new Set([
  '.md',
  '.txt',
  '.json',
  '.yaml',
  '.yml',
  '.toml',
  '.csv',
  '.tsv',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.py',
  '.rs',
  '.go',
  '.java',
  '.c',
  '.cpp',
  '.h',
  '.css',
  '.scss',
  '.html',
]);

export const EXERCISE_ZIP_IGNORE_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  'dist',
  'build',
  'target',
  '.next',
  '.cache',
  'coverage',
  '__pycache__',
]);
