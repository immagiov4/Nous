export interface NousRuntimeConfig {
  authMode?: 'local-bypass' | 'supabase';
  backendUrl?: string;
  supabaseAnonKey?: string;
  supabaseUrl?: string;
}

export const getNousRuntimeConfig = (): NousRuntimeConfig =>
  ((globalThis as Record<string, unknown>).__NOUS_RUNTIME_CONFIG__ as
    | NousRuntimeConfig
    | undefined) || {};
