import { createHmac } from 'node:crypto';

const base64UrlJson = (value: unknown): string =>
  Buffer.from(JSON.stringify(value)).toString('base64url');

export const signSupabaseJwt = (payload: Record<string, unknown>, secret: string): string => {
  const header = base64UrlJson({ alg: 'HS256', typ: 'JWT' });
  const body = base64UrlJson(payload);
  const signature = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');

  return `${header}.${body}.${signature}`;
};

export const createSupabaseTestToken = ({
  role = 'user',
  secret = 'test-secret',
  userId = 'user-123',
}: {
  role?: string;
  secret?: string;
  userId?: string;
} = {}): string =>
  signSupabaseJwt(
    {
      sub: userId,
      exp: Math.floor(Date.now() / 1000) + 60,
      app_metadata: {
        role,
      },
    },
    secret
  );
