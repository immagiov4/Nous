import { readFileSync } from 'node:fs';

import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import reactHooks from 'eslint-plugin-react-hooks';
import sonarjs from 'eslint-plugin-sonarjs';
import unicorn from 'eslint-plugin-unicorn';
import lintProject from './tsconfig.eslint.json' with { type: 'json' };

const sonarProperties = readFileSync(
  new URL('./sonar-project.properties', import.meta.url),
  'utf8'
);
const testProperties = new Map(
  [
    ...sonarProperties.matchAll(
      /^[ \t]*(sonar\.tests|sonar\.test\.inclusions)[ \t]*=[ \t]*(.*)$/gmu
    ),
  ].map(([, key, value]) => [
    key,
    value
      .split(',')
      .map(entry => entry.trim())
      .filter(Boolean),
  ])
);
const testPaths = testProperties.get('sonar.tests');
const testInclusions = testProperties.get('sonar.test.inclusions');
if (!testPaths?.length || !testInclusions?.length) {
  throw new Error(
    'sonar.tests and sonar.test.inclusions must define the Sonar test classification.'
  );
}

const config = [
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/vendor/**',
      '**/generated/**',
      '**/*.generated.*',
      '**/fixtures/**',
      '**/*.d.ts',
      '**/*.{js,jsx,mjs,cjs}',
    ],
  },
  {
    files: lintProject.include.map(pattern => pattern.replace(/^\.\.\//u, '')),
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: './tsconfig.eslint.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    // Hook directives are checked by the separate React Hooks runner.
    plugins: { sonarjs, '@typescript-eslint': tsPlugin, unicorn, 'react-hooks': reactHooks },
    linterOptions: { reportUnusedDisableDirectives: false },
    // These are the requested SonarWay rules, including Sonar's external-plugin equivalents.
    rules: {
      'sonarjs/cognitive-complexity': ['error', 15], // S3776
      'sonarjs/no-nested-functions': ['error', { threshold: 4 }], // S2004
      'sonarjs/no-nested-conditional': 'error', // S3358
      'sonarjs/no-nested-template-literals': 'error', // S4624
      'sonarjs/deprecation': 'error', // S1874
      'sonarjs/no-misleading-array-reverse': 'error', // S4043
      'sonarjs/no-alphabetical-sort': 'error', // S2871
      'sonarjs/no-redundant-optional': 'error', // S4782
      '@typescript-eslint/no-base-to-string': 'error', // S6551
      '@typescript-eslint/prefer-optional-chain': 'error', // S6582
      '@typescript-eslint/await-thenable': 'error', // S4123
      'unicorn/prefer-string-replace-all': 'error', // S7781
      'unicorn/prefer-string-raw': 'error', // S7780
      'unicorn/consistent-function-scoping': 'error', // S7721
      'unicorn/prefer-top-level-await': 'error', // S7785
    },
  },
];

// Match sonar.tests and sonar.test.inclusions: the selected rules all have Main scope.
export default [
  ...config,
  {
    files: testPaths.flatMap(testPath =>
      testInclusions.flatMap(inclusion => [
        [testPath, inclusion],
        [`${testPath.replace(/\/$/u, '')}/**/*`, inclusion],
      ])
    ),
    rules: Object.fromEntries(Object.keys(config[1].rules).map(rule => [rule, 'off'])),
  },
];
