import { z } from 'zod';

const isLocalhost = (value: string): boolean => {
  try { const url = new URL(value); return ['localhost', '127.0.0.1', '::1'].includes(url.hostname); } catch { return false; }
};

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  JWT_ACCESS_SECRET: z.string().min(16, 'JWT_ACCESS_SECRET must be at least 16 characters'),
  JWT_ACCESS_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_SECRET: z.string().min(16, 'JWT_REFRESH_SECRET must be at least 16 characters'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('30d'),
  CORS_ORIGIN: z.string().default('http://localhost:3000'),
  FRONTEND_URL: z.string().default('http://localhost:3000'),
  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_MODEL: z.string().default('anthropic/claude-3.5-sonnet'),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  S3_ENDPOINT: z.string().optional(), S3_REGION: z.string().default('auto'), S3_BUCKET: z.string().optional(), S3_ACCESS_KEY_ID: z.string().optional(), S3_SECRET_ACCESS_KEY: z.string().optional(),
  SMTP_HOST: z.string().optional(), SMTP_PORT: z.coerce.number().int().positive().default(587), SMTP_SECURE: z.string().default('false').transform((v) => v === 'true'), SMTP_USER: z.string().optional(), SMTP_PASSWORD: z.string().optional(), SMTP_FROM_ADDRESS: z.string().optional(),
  WHATSAPP_ENCRYPTION_KEY: z.string().min(16, 'WHATSAPP_ENCRYPTION_KEY must be at least 16 characters').optional(),
  WHATSAPP_VERIFY_TOKEN: z.string().min(8, 'WHATSAPP_VERIFY_TOKEN must be at least 8 characters').optional(),
  WHATSAPP_GRAPH_VERSION: z.string().default('v23.0'),
}).superRefine((config, ctx) => {
  if (config.NODE_ENV !== 'production') return;
  if (config.JWT_ACCESS_SECRET.length < 32) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['JWT_ACCESS_SECRET'], message: 'Production JWT_ACCESS_SECRET must be at least 32 characters' });
  if (config.JWT_REFRESH_SECRET.length < 32) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['JWT_REFRESH_SECRET'], message: 'Production JWT_REFRESH_SECRET must be at least 32 characters' });
  if (isLocalhost(config.DATABASE_URL)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['DATABASE_URL'], message: 'Production DATABASE_URL must not point to localhost' });
  for (const origin of config.CORS_ORIGIN.split(',').map((v) => v.trim())) { try { if (new URL(origin).protocol !== 'https:') ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['CORS_ORIGIN'], message: 'Production CORS_ORIGIN entries must use HTTPS' }); } catch { ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['CORS_ORIGIN'], message: 'Production CORS_ORIGIN must contain valid absolute URLs' }); } }
  try { if (new URL(config.FRONTEND_URL).protocol !== 'https:') ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['FRONTEND_URL'], message: 'Production FRONTEND_URL must use HTTPS' }); } catch { ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['FRONTEND_URL'], message: 'Production FRONTEND_URL must be a valid absolute URL' }); }
  if (isLocalhost(config.REDIS_URL)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['REDIS_URL'], message: 'Production REDIS_URL must not point to localhost' });
  if (!config.WHATSAPP_ENCRYPTION_KEY) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['WHATSAPP_ENCRYPTION_KEY'], message: 'Production WhatsApp encryption key is required' });
  if (!config.WHATSAPP_VERIFY_TOKEN) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['WHATSAPP_VERIFY_TOKEN'], message: 'Production WhatsApp webhook verify token is required' });
});

export type EnvConfig = z.infer<typeof envSchema>;
export function validateEnv(config: Record<string, unknown>): EnvConfig {
  const parsed = envSchema.safeParse(config);
  if (!parsed.success) throw new Error(`Invalid environment configuration:\n${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n')}`);
  return parsed.data;
}
