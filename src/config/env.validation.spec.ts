import { validateEnv } from './env.validation';

describe('production environment validation', () => {
  const validProduction = {
    NODE_ENV: 'production',
    PORT: 4000,
    DATABASE_URL: 'postgresql://user:password@db.example.com:5432/mygymagent?schema=public',
    JWT_ACCESS_SECRET: 'a'.repeat(32),
    JWT_REFRESH_SECRET: 'b'.repeat(32),
    CORS_ORIGIN: 'https://app.mygymagent.com',
    FRONTEND_URL: 'https://app.mygymagent.com',
    REDIS_URL: 'redis://redis.example.com:6379',
    WHATSAPP_ENCRYPTION_KEY: 'c'.repeat(32),
    WHATSAPP_VERIFY_TOKEN: 'whatsapp-test-token',
  };

  it('accepts a real HTTPS production configuration', () => {
    expect(() => validateEnv(validProduction)).not.toThrow();
  });

  it('rejects production localhost database and Redis fallbacks', () => {
    expect(() =>
      validateEnv({
        ...validProduction,
        DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/mygymagent',
        REDIS_URL: 'redis://localhost:6379',
      }),
    ).toThrow(/localhost/);
  });

  it('rejects production HTTP origins', () => {
    expect(() =>
      validateEnv({
        ...validProduction,
        CORS_ORIGIN: 'http://app.mygymagent.com',
        FRONTEND_URL: 'http://app.mygymagent.com',
      }),
    ).toThrow(/HTTPS/);
  });

  it('rejects short or placeholder JWT secrets in production', () => {
    expect(() =>
      validateEnv({
        ...validProduction,
        JWT_ACCESS_SECRET: 'change-me',
      }),
    ).toThrow(/JWT_ACCESS_SECRET/);

    expect(() =>
      validateEnv({
        ...validProduction,
        JWT_REFRESH_SECRET: 'change-me-in-production-please',
      }),
    ).toThrow(/JWT_REFRESH_SECRET/);
  });
});
