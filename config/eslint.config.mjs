import tsParser from '@typescript-eslint/parser';
import reactHooks from 'eslint-plugin-react-hooks';

const WEB_FILE_GLOB = 'apps/web/**/*.{js,jsx,ts,tsx}';

export default [
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/.git/**',
      '**/.codex/**',
      '**/.claude/**',
      '**/.dyad/**',
      '**/coverage/**',
      'graphify-out/**',
    ],
  },
  {
    files: [WEB_FILE_GLOB],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaFeatures: {
          jsx: true,
        },
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      ...reactHooks.configs.flat['recommended-latest'].rules,
    },
  },
];
