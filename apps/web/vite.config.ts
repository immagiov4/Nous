import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

const DEFAULT_BACKEND_HOST = '127.0.0.1';
const DEFAULT_BACKEND_PORT = 3301;

const normalizeProxyHost = (value: string | undefined): string => {
  const host = value?.trim() || DEFAULT_BACKEND_HOST;
  return host === '0.0.0.0' || host === '::' ? DEFAULT_BACKEND_HOST : host;
};

const normalizeProxyPort = (value: string | undefined): number => {
  const port = Number.parseInt(value || '', 10);
  return Number.isInteger(port) && port > 0 ? port : DEFAULT_BACKEND_PORT;
};

export const buildViteApiProxy = (env: Record<string, string | undefined>) => ({
  '/api': {
    changeOrigin: true,
    target: `http://${normalizeProxyHost(env.VITE_BACKEND_HOST)}:${normalizeProxyPort(
      env.VITE_BACKEND_PORT
    )}`,
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
      proxy: buildViteApiProxy(env),
      strictPort: true,
    },
    plugins: [react()],
    define: {
      'process.env.MODEL_CONTEXT': JSON.stringify(env.MODEL_CONTEXT),
      'process.env.MODEL_FLASH': JSON.stringify(env.MODEL_FLASH),
      'process.env.MODEL_REASONING': JSON.stringify(env.MODEL_REASONING),
      'process.env.MAX_OUTPUT_TOKENS': JSON.stringify(env.MAX_OUTPUT_TOKENS),
    },
    resolve: {
      dedupe: ['react', 'react-dom'],
      alias: {
        '@': path.resolve(__dirname, '.'),
        '@shared': path.resolve(repoRoot, 'packages/shared-types'),
        react: path.resolve(rootNodeModules, 'react'),
        'react-dom': path.resolve(rootNodeModules, 'react-dom'),
        'react/jsx-dev-runtime': path.resolve(rootNodeModules, 'react/jsx-dev-runtime.js'),
        'react/jsx-runtime': path.resolve(rootNodeModules, 'react/jsx-runtime.js'),
      },
    },
  };
});
