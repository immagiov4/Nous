import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  return {
    server: {
      port: 5173,
      host: '0.0.0.0',
    },
    plugins: [react()],
    define: {
      'process.env.OPENROUTER_API_KEY': JSON.stringify(env.OPENROUTER_API_KEY),
      'process.env.MODEL_CONTEXT': JSON.stringify(env.MODEL_CONTEXT),
      'process.env.MODEL_FLASH': JSON.stringify(env.MODEL_FLASH),
      'process.env.MODEL_REASONING': JSON.stringify(env.MODEL_REASONING),
      'process.env.MAX_OUTPUT_TOKENS': JSON.stringify(env.MAX_OUTPUT_TOKENS),
      'process.env.PROJECT_REPOSITORY_MODE': JSON.stringify(env.PROJECT_REPOSITORY_MODE),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
  };
});
