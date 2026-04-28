import { existsSync, readFileSync } from 'node:fs';

import { getErrorMessage } from '../utils/errors.js';

export function loadOptionalJsonFile<T>(filePath: string, label: string): T | null {
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const fileContent = readFileSync(filePath, 'utf-8');
    return JSON.parse(fileContent) as T;
  } catch (error) {
    throw new Error(`[Config] ${label} non valido: ${getErrorMessage(error)}`);
  }
}
