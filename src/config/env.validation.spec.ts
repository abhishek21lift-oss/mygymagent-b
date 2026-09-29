import { validateEnv } from './env.validation';

describe('production environment validation', () => {
  const validProduction = {
    NODE_ENV: 'production',
    PORT: 4000,
    DATABASE_URL:
      'postgresql://user:password@db.example.com:5432/mygymagent?schema=public',
    JWT_ACCESS_SECRET: 'a'.repeat(32),
    JWT_REFRESH_SECRET: 'b'.repeat(32),
    CORS_ORIGIN: 'https://app.mygymagent.com',
    FRONTEND_URL: 'https://app.mygymagent.com',
    REDIS_URL: 'redis://redis.example.com:6379',
  };

  it('accepts a real HTTPS production configuration', () => {
    expect(() => validateEnv(validProduction)).not.toThrow();
  });

  it('rejects production localhost database and Redis fallbacks', () => {
    expect(() =>
      validateEnv({
        ...validProduction,
        DATABASE_URL:
          'postgresql://postgres:postgres@localhost:5432/mygymagent',
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

describe('member OTP provider configuration', () => {
  const base = {
    DATABASE_URL:
      'postgresql://postgres@127.0.0.1:5432/mygymagent?schema=public',
    JWT_ACCESS_SECRET: 'a'.repeat(32),
    JWT_REFRESH_SECRET: 'b'.repeat(32),
  };

  const production = {
    ...base,
    NODE_ENV: 'production',
    CORS_ORIGIN: 'https://app.mygymagent.com',
    FRONTEND_URL: 'https://app.mygymagent.com',
    REDIS_URL: 'redis://redis.example.com:6379',
  };

  it('defaults to msg91, so a deployment that sets nothing new is unchanged', () => {
    const parsed = validateEnv({ ...base, NODE_ENV: 'development' });
    expect(parsed.OTP_PROVIDER).toBe('msg91');
    expect(parsed.OTP_EXPIRY_SECONDS).toBe(300);
  });

  it('accepts the mock provider outside production', () => {
    for (const nodeEnv of ['development', 'test']) {
      expect(() =>
        validateEnv({ ...base, NODE_ENV: nodeEnv, OTP_PROVIDER: 'mock' }),
      ).not.toThrow();
    }
  });

  it('refuses to boot production with the mock provider selected', () => {
    expect(() => validateEnv({ ...production, OTP_PROVIDER: 'mock' })).toThrow(
      /OTP_PROVIDER/,
    );
  });

  it('refuses to boot production with MOCK_OTP set, even alongside msg91', () => {
    // The provider check and this one are deliberately independent. A
    // stray MOCK_OTP beside a real msg91 selection has no effect today,
    // but it is a fixed code sitting in the environment waiting for the
    // next deploy to select the mock provider and start honouring it.
    expect(() =>
      validateEnv({ ...production, OTP_PROVIDER: 'msg91', MOCK_OTP: '123456' }),
    ).toThrow(/MOCK_OTP/);
  });

  it('rejects a MOCK_OTP that is not exactly six digits', () => {
    expect(() =>
      validateEnv({ ...base, NODE_ENV: 'development', MOCK_OTP: '12345' }),
    ).toThrow(/MOCK_OTP/);
    expect(() =>
      validateEnv({ ...base, NODE_ENV: 'development', MOCK_OTP: '1234567' }),
    ).toThrow(/MOCK_OTP/);
    expect(() =>
      validateEnv({ ...base, NODE_ENV: 'development', MOCK_OTP: 'abcdef' }),
    ).toThrow(/MOCK_OTP/);
  });

  it('rejects an unknown provider rather than defaulting it to something real', () => {
    expect(() =>
      validateEnv({ ...base, NODE_ENV: 'development', OTP_PROVIDER: 'twilio' }),
    ).toThrow(/OTP_PROVIDER/);
  });

  it('bounds the code lifetime, so a typo cannot leave codes spendable for a day', () => {
    expect(() =>
      validateEnv({ ...base, NODE_ENV: 'development', OTP_EXPIRY_SECONDS: 10 }),
    ).toThrow(/at least 30/);
    expect(() =>
      validateEnv({
        ...base,
        NODE_ENV: 'development',
        OTP_EXPIRY_SECONDS: 86400,
      }),
    ).toThrow(/at most 900/);
    expect(() =>
      validateEnv({ ...base, NODE_ENV: 'development', OTP_EXPIRY_SECONDS: 60 }),
    ).not.toThrow();
  });
});
