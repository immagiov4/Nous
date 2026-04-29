import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const backendRoot = resolve(__dirname, '..', '..');
const repoRoot = resolve(backendRoot, '..', '..');

const loadEnvFile = (absolutePath: string) => {
  dotenv.config({
    path: absolutePath,
    override: false,
  });
};

loadEnvFile(resolve(backendRoot, '.env.local'));
loadEnvFile(resolve(backendRoot, '.env'));
loadEnvFile(resolve(repoRoot, '.env.local'));
loadEnvFile(resolve(repoRoot, '.env'));
