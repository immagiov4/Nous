import { APICallError } from 'ai';
import { CodexAppServerError } from './codexAppServer.js';

export const isResearchProviderUnavailable = (error: unknown): boolean =>
  (APICallError.isInstance(error) && error.isRetryable) ||
  (error instanceof CodexAppServerError && (error.code === 'process' || error.code === 'timeout'));
