import { z } from 'zod';

const isLocalhost = (value: string): boolean => {
  try {
    const url = new URL(value);
    return ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  } catch {
    return false;
  }
};

export const envSchema = z
  .object({
    NODE_ENV: z
      .enum(['development', 'test', 'production'])
      .default('development'),
    PORT: z.coerce.number().int().positive().default(4000),

    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

    JWT_ACCESS_SECRET: z
      .string()
      .min(16, 'JWT_ACCESS_SECRET must be at least 16 characters'),
    JWT_ACCESS_EXPIRES_IN: z.string().default('15m'),
    JWT_REFRESH_SECRET: z
      .string()
      .min(16, 'JWT_REFRESH_SECRET must be at least 16 characters'),
    JWT_REFRESH_EXPIRES_IN: z.string().default('30d'),

    CORS_ORIGIN: z.string().default('http://localhost:3000'),

    // Base URL of the frontend app, for building links inside outbound
    // messages (e.g. the password-reset email's reset link). Distinct from
    // CORS_ORIGIN because that field can be a comma-separated allowlist;
    // this is always exactly one URL.
    FRONTEND_URL: z.string().default('http://localhost:3000'),

    // AI (OpenRouter) -- optional. The /ai/chat endpoint returns a clear
    // 503 if invoked without OPENROUTER_API_KEY set, rather than the app
    // failing to boot over a missing optional integration.
    OPENROUTER_API_KEY: z.string().optional(),
    OPENROUTER_MODEL: z.string().default('anthropic/claude-3.5-sonnet'),

    // Redis, for the BullMQ job queue (src/queue/). Defaults to a local
    // instance so dev/test never need to set this explicitly; production
    // validation below rejects the local fallback.
    REDIS_URL: z.string().default('redis://localhost:6379'),

    // Object storage (src/files/), S3-compatible -- Cloudflare R2 in
    // production, s3rver locally. Optional and checked together at call
    // time; upload endpoints return a clear 503 when it is unavailable.
    S3_ENDPOINT: z.string().optional(),
    S3_REGION: z.string().default('auto'),
    S3_BUCKET: z.string().optional(),
    S3_ACCESS_KEY_ID: z.string().optional(),
    S3_SECRET_ACCESS_KEY: z.string().optional(),

    // Email (src/communications/), via SMTP -- optional.
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.coerce.number().int().positive().default(587),
    SMTP_SECURE: z
      .string()
      .default('false')
      .transform((v) => v === 'true'),
    SMTP_USER: z.string().optional(),
    SMTP_PASSWORD: z.string().optional(),
    SMTP_FROM_ADDRESS: z.string().optional(),
  })
  .superRefine((config, ctx) => {
    if (config.NODE_ENV !== 'production') return;

    if (config.JWT_ACCESS_SECRET.length < 32) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['JWT_ACCESS_SECRET'],
        message: 'Production JWT_ACCESS_SECRET must be at least 32 characters',
      });
    }
    if (config.JWT_REFRESH_SECRET.length < 32) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['JWT_REFRESH_SECRET'],
        message: 'Production JWT_REFRESH_SECRET must be at least 32 characters',
      });
    }

    const forbiddenSecrets = new Set([
      'change-me',
      'change-me-in-production-please',
      'dev-access-secret-change-me-in-production-please',
      'dev-refresh-secret-change-me-in-production-please',
    ]);
    if (forbiddenSecrets.has(config.JWT_ACCESS_SECRET)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['JWT_ACCESS_SECRET'],
        message: 'Production JWT_ACCESS_SECRET must not use a placeholder value',
      });
    }
    if (forbiddenSecrets.has(config.JWT_REFRESH_SECRET)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['JWT_REFRESH_SECRET'],
        message: 'Production JWT_REFRESH_SECRET must not use a placeholder value',
      });
    }

    if (isLocalhost(config.DATABASE_URL)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['DATABASE_URL'],
        message: 'Production DATABASE_URL must not point to localhost',
      });
    }

    const corsOrigins = config.CORS_ORIGIN.split(',').map((origin) => origin.trim());
    for (const origin of corsOrigins) {
      try {
        const url = new URL(origin);
        if (url.protocol !== 'https:') {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['CORS_ORIGIN'],
            message: 'Production CORS_ORIGIN entries must use HTTPS',
          });
        }
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['CORS_ORIGIN'],
          message: 'Production CORS_ORIGIN must contain valid absolute URLs',
        });
      }
    }

    if (isLocalhost(config.FRONTEND_URL)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['FRONTEND_URL'],
        message: 'Production FRONTEND_URL must not point to localhost',
      });
    }
    try {
      if (new URL(config.FRONTEND_URL).protocol !== 'https:') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['FRONTEND_URL'],
          message: 'Production FRONTEND_URL must use HTTPS',
        });
      }
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['FRONTEND_URL'],
        message: 'Production FRONTEND_URL must be a valid absolute URL',
      });
    }

    if (isLocalhost(config.REDIS_URL)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['REDIS_URL'],
        message: 'Production REDIS_URL must not point to localhost',
      });
    }
  });

export type EnvConfig = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): EnvConfig {
  const parsed = envSchema.safeParse(config);
  if (!parsed.success) {
    const message = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${message}`);
  }
  return parsed.data;
}
