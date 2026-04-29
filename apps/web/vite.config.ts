import path from 'node:path';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';
import { defineConfig, loadEnv } from 'vite';

const FULL_RELOAD_HOT_UPDATE_FILES = new Set([
  'App.tsx',
  path.join('components', 'shared', 'GeneratedVisualFrame.tsx'),
  path.join('utils', 'visuals', 'generatedVisualHost.ts'),
]);

const fullReloadSensitiveHotUpdates = (): Plugin => ({
  name: 'full-reload-sensitive-hot-updates',
  handleHotUpdate({ file, server }) {
    const normalizedFile = file.split(path.sep).join('/');
    const shouldReload = [...FULL_RELOAD_HOT_UPDATE_FILES].some(reloadFile =>
      normalizedFile.endsWith(reloadFile.split(path.sep).join('/'))
    );
    if (!shouldReload) {
      return;
    }

    server.ws.send({ type: 'full-reload' });
    return [];
  },
});

export default defineConfig(({ mode }) => {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const env = loadEnv(mode, repoRoot, '');
  const rootNodeModules = path.resolve(repoRoot, 'node_modules');
  return {
    root: __dirname,
    envDir: repoRoot,
    server: {
      port: 5173,
      host: '0.0.0.0',
    },
    plugins: [react(), fullReloadSensitiveHotUpdates()],
    define: {
      'process.env.MODEL_CONTEXT': JSON.stringify(env.MODEL_CONTEXT),
      'process.env.MODEL_FLASH': JSON.stringify(env.MODEL_FLASH),
      'process.env.MODEL_REASONING': JSON.stringify(env.MODEL_REASONING),
      'process.env.MAX_OUTPUT_TOKENS': JSON.stringify(env.MAX_OUTPUT_TOKENS),
      'process.env.PROJECT_REPOSITORY_MODE': JSON.stringify(env.PROJECT_REPOSITORY_MODE),
    },
    resolve: {
      dedupe: ['react', 'react-dom'],
      alias: {
        '@': path.resolve(__dirname, '.'),
        react: path.resolve(rootNodeModules, 'react'),
        'react-dom': path.resolve(rootNodeModules, 'react-dom'),
        'react/jsx-dev-runtime': path.resolve(rootNodeModules, 'react/jsx-dev-runtime.js'),
        'react/jsx-runtime': path.resolve(rootNodeModules, 'react/jsx-runtime.js'),
      },
    },
  };
});
