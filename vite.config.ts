import path from 'node:path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

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
        'process.env.MAX_OUTPUT_TOKENS': JSON.stringify(env.MAX_OUTPUT_TOKENS)
      },
      resolve: {
        alias: {
          '@': path.resolve(__dirname, '.'),
        }
      }
    };
});
