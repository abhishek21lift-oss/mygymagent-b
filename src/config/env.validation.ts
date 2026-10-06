import { z } from 'zod';

const isLocalhost = (value: string): boolean => {
  try {
    return ['localhost', '127.0.0.1', '::1'].includes(new URL(value).hostname);
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

    CORS_ORIGIN: z.string().optional(),

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

    // FreeLLMAPI management integration -- optional server-side only.
    // Dashboard session (email+password) is held ONLY in this backend and
    // never sent to the browser; unset means /admin/ai/* returns 503.
    // No NEXT_PUBLIC_* variable may ever carry these values.
    FREELLM_BASE_URL: z.string().url().default('http://127.0.0.1:3001'),
    FREELLM_EMAIL: z.string().email().optional(),
    FREELLM_PASSWORD: z.string().min(1).optional(),
    FREELLM_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),

    // Redis, for the BullMQ job queue (src/queue/). Defaults to a local
    // instance so dev/test never need to set this explicitly; every
    // deployment (Render, CI) must set a real REDIS_URL. Connection failures
    // never block app boot or fail an unrelated request -- a job producer's
    // enqueue call just stays pending until Redis is reachable again rather
    // than erroring (see the class comment on MemberCreatedListener for why).
    REDIS_URL: z.string().default('redis://localhost:6379'),
    // Optional name for this deployment's BullMQ keys. Unset, it is derived
    // from DATABASE_URL, which already keeps deployments that share a Redis
    // apart -- see src/queue/queue-prefix.ts.
    QUEUE_PREFIX: z
      .string()
      .regex(
        /^[A-Za-z0-9_-]+$/,
        'QUEUE_PREFIX may use letters, digits, - and _ only',
      )
      .optional(),

    // Object storage (src/files/), S3-compatible -- Cloudflare R2 in
    // production, s3rver locally (see docker-compose.yml / README). All
    // optional and checked together at call time (FileStorageService),
    // same pattern as OPENROUTER_API_KEY: unset means upload endpoints
    // return a clear 503 rather than the app failing to boot over a
    // missing optional integration.
    S3_ENDPOINT: z.string().optional(),
    S3_REGION: z.string().default('auto'),
    S3_BUCKET: z.string().optional(),
    S3_ACCESS_KEY_ID: z.string().optional(),
    S3_SECRET_ACCESS_KEY: z.string().optional(),

    // Email (src/communications/), via SMTP -- optional, same
    // check-together-at-call-time pattern as S3_*. Unset means
    // CommunicationsService logs instead of sending (see
    // SmtpEmailProvider), same degraded behavior the old MailerService
    // stub always had, but now visible in MessageLog rather than silent.
    // MSG91 carries member login codes. Optional together, like SMTP_*
    // and S3_*: unset means SMS login refuses up front (see
    // Msg91SmsProvider.isConfigured) rather than issuing codes that
    // cannot be delivered. MSG91_OTP_TEMPLATE_ID is the DLT-registered
    // template, MSG91_OTP_VAR the variable inside it the code fills --
    // that name is fixed when the template is approved, not by us.
    MSG91_AUTH_KEY: z.string().optional(),
    MSG91_OTP_TEMPLATE_ID: z.string().optional(),
    MSG91_SENDER_ID: z.string().optional(),
    MSG91_OTP_VAR: z.string().optional(),
    /** MSG91 serves regional endpoints; unset uses the default. */
    MSG91_FLOW_URL: z.string().url().optional(),

    // Push over FCM (src/communications/providers/fcm-push.provider.ts).
    // The service account JSON Firebase issues, raw or base64. Unset means
    // push is off: devices can still register, and every attempted send
    // is logged FAILED rather than dropped. The two URLs exist so a test
    // can point at a local fake instead of Google; leave them unset.
    FCM_SERVICE_ACCOUNT_JSON: z.string().optional(),
    FCM_TOKEN_URL: z.string().url().optional(),
    FCM_API_BASE_URL: z.string().url().optional(),
    FCM_DEFAULT_TITLE: z.string().optional(),

    // How a member login code is produced and delivered. `msg91` is the
    // only real option: a CSPRNG code, hashed here, carried by SMS.
    // `mock` exists so a developer or a test can exercise the whole OTP
    // flow -- request, verify, expiry, the session it starts -- without
    // a carrier account, a DLT-registered template, or a real handset.
    //
    // The name is deliberately explicit rather than a `DEBUG`-style flag:
    // anything that can put a fixed code in front of an authentication
    // boundary has to be something you can grep for, type on purpose,
    // and be refused at boot when NODE_ENV is production.
    OTP_PROVIDER: z.enum(['msg91', 'mock']).default('msg91'),
    /** The code `mock` hands out. Six digits, nothing looser. */
    MOCK_OTP: z
      .string()
      .regex(/^[0-9]{6}$/, 'MOCK_OTP must be exactly six digits')
      .optional(),
    /**
     * How long a code stays spendable. Capped at 15 minutes because this
     * is the window an attacker gets to guess, and there is no reason
     * for a longer one: the code is a session opener, not a mailbox.
     */
    OTP_EXPIRY_SECONDS: z.coerce
      .number()
      .int()
      .min(30, 'OTP_EXPIRY_SECONDS must be at least 30')
      .max(900, 'OTP_EXPIRY_SECONDS must be at most 900')
      .default(300),

    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.coerce.number().int().positive().default(587),
    // Not z.coerce.boolean(): that's `Boolean(value)` under the hood, which
    // is true for ANY non-empty string -- including the literal text
    // "false". An explicit string match is the only way an env var of
    // "false" actually produces `false`.
    SMTP_SECURE: z
      .string()
      .default('false')
      .transform((v) => v === 'true'),
    SMTP_USER: z.string().optional(),
    SMTP_PASSWORD: z.string().optional(),
    SMTP_FROM_ADDRESS: z.string().optional(),

    // WhatsApp Business onboarding (src/whatsapp/), via Meta Cloud API --
    // all optional. Unset means POST /whatsapp/integration/embedded-signup
    // returns a clear 503 naming the missing variables instead of failing
    // mid-exchange, the same check-together-at-call-time pattern SMTP uses.
    META_APP_ID: z.string().optional(),
    META_APP_SECRET: z.string().optional(),
    WHATSAPP_GRAPH_VERSION: z.string().default('v25.0'),
    // WS-2 vault + webhook verify tokens (src/whatsapp/). Both optional at
    // boot, same check-together-at-call-time pattern as META_APP_ID above:
    // WHATSAPP_TOKEN_KEY is the 32-byte-hex AES-256-GCM key for the
    // per-org credential vault -- unset means the connect and test-send
    // endpoints return a clear 503 instead of storing/sending anything.
    // META_WABA_VERIFY_TOKEN is compared against Meta's hub.verify_token on
    // GET /whatsapp/webhook -- unset means verification always fails closed.
    WHATSAPP_TOKEN_KEY: z.string().optional(),
    META_WABA_VERIFY_TOKEN: z.string().optional(),

    // WhatsApp Web through Baileys (src/whatsapp-web/) -- an unofficial
    // client, so off unless a deployment opts in. Needs WHATSAPP_TOKEN_KEY
    // to encrypt the linked sessions. The gap settings space one gym's
    // messages at least MIN_GAP apart plus up to JITTER more.
    WHATSAPP_WEB_ENABLED: z.enum(['true', 'false']).default('false'),
    WHATSAPP_WEB_MIN_GAP_MS: z.coerce.number().int().min(0).default(8_000),
    WHATSAPP_WEB_JITTER_MS: z.coerce.number().int().min(0).default(7_000),
    // How long to wait for WhatsApp's first answer (a QR) when linking.
    WHATSAPP_WEB_PAIRING_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .default(45_000),

    // MFA_TOTP_KEY is the 32-byte-hex AES-256-GCM key wrapping each user's
    // TOTP secret (src/auth/mfa/mfa-secret.vault.ts). Optional at boot so a
    // deployment that hasn't turned on 2FA still starts; the enrolment
    // endpoints answer 503 until it is set. Generate: `openssl rand -hex 32`.
    MFA_TOTP_KEY: z.string().optional(),

    // Stripe webhooks (src/payments/stripe-webhook.controller.ts) -- optional
    // at boot. Unset means POST /payments/webhook returns a clear 500 naming
    // the missing secret instead of the app failing to boot over a missing
    // optional integration, same pattern as OPENROUTER_API_KEY.
    STRIPE_WEBHOOK_SECRET: z.string().optional(),

    // Razorpay online collection (src/payments/razorpay.service.ts,
    // src/invoices/) -- optional at boot, same
    // check-together-at-call-time pattern as STRIPE_*. Unset means
    // POST /payments/online/razorpay/order (and invoice retry-collection)
    // return a clear 503 naming the missing variables, and the Razorpay
    // webhook endpoint rejects with a 500, rather than the app failing to
    // boot over a missing optional integration.
    RAZORPAY_KEY_ID: z.string().optional(),
    RAZORPAY_KEY_SECRET: z.string().optional(),
    RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
  })
  // The defaults above keep dev and test frictionless, but every one of
  // them is unsafe to actually deploy on: a localhost database, a plaintext
  // origin, or a committed placeholder secret. Boot fails loudly in
  // production rather than serving traffic on them.
  .superRefine((config, ctx) => {
    if (config.NODE_ENV !== 'production') return;

    const reject = (path: string, message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });

    // 16 chars passes the base schema for dev; production wants real entropy.
    if (config.JWT_ACCESS_SECRET.length < 32) {
      reject(
        'JWT_ACCESS_SECRET',
        'Production JWT_ACCESS_SECRET must be at least 32 characters',
      );
    }
    if (config.JWT_REFRESH_SECRET.length < 32) {
      reject(
        'JWT_REFRESH_SECRET',
        'Production JWT_REFRESH_SECRET must be at least 32 characters',
      );
    }

    // Placeholders shipped in .env.example and docker-compose.yml. Long
    // enough to clear the length check, so match them explicitly.
    const forbiddenSecrets = new Set([
      'change-me',
      'change-me-in-production-please',
      'dev-access-secret-change-me-in-production-please',
      'dev-refresh-secret-change-me-in-production-please',
    ]);
    if (forbiddenSecrets.has(config.JWT_ACCESS_SECRET)) {
      reject(
        'JWT_ACCESS_SECRET',
        'Production JWT_ACCESS_SECRET must not use a placeholder value',
      );
    }
    if (forbiddenSecrets.has(config.JWT_REFRESH_SECRET)) {
      reject(
        'JWT_REFRESH_SECRET',
        'Production JWT_REFRESH_SECRET must not use a placeholder value',
      );
    }

    if (isLocalhost(config.DATABASE_URL)) {
      reject(
        'DATABASE_URL',
        'Production DATABASE_URL must not point to localhost',
      );
    }
    if (isLocalhost(config.REDIS_URL)) {
      reject('REDIS_URL', 'Production REDIS_URL must not point to localhost');
    }

    // CORS_ORIGIN is a comma-separated allowlist; every entry must be HTTPS.
    // Unlike the other fields it is genuinely optional here -- main.ts throws
    // on a production boot without it and only falls back to localhost
    // origins in development, so there is no hardcoded origin left to check.
    const corsOrigins = (config.CORS_ORIGIN ?? '')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean);
    for (const origin of corsOrigins) {
      try {
        if (new URL(origin).protocol !== 'https:') {
          reject(
            'CORS_ORIGIN',
            'Production CORS_ORIGIN entries must use HTTPS',
          );
        }
      } catch {
        reject(
          'CORS_ORIGIN',
          'Production CORS_ORIGIN must contain valid absolute URLs',
        );
      }
    }

    if (isLocalhost(config.FRONTEND_URL)) {
      reject(
        'FRONTEND_URL',
        'Production FRONTEND_URL must not point to localhost',
      );
    }
    try {
      if (new URL(config.FRONTEND_URL).protocol !== 'https:') {
        reject('FRONTEND_URL', 'Production FRONTEND_URL must use HTTPS');
      }
    } catch {
      reject(
        'FRONTEND_URL',
        'Production FRONTEND_URL must be a valid absolute URL',
      );
    }

    // The mock OTP provider is a fixed, publicly-known code in front of
    // an authentication boundary. In production it is not a
    // misconfiguration to warn about, it is a way in, so the process
    // refuses to start rather than falling back to MSG91 and leaving the
    // hole quietly closed. Two separate checks because either alone can
    // be defeated by the other being set: selecting `mock` with no
    // MOCK_OTP would fall back to a random code, and a stray MOCK_OTP
    // beside a real `msg91` selection would still be a value sitting in
    // the environment waiting for the next careless deploy.
    if (config.OTP_PROVIDER === 'mock') {
      reject(
        'OTP_PROVIDER',
        'Production OTP_PROVIDER must be "msg91"; the mock provider issues a fixed code and must never run in production',
      );
    }
    if (config.MOCK_OTP !== undefined) {
      reject(
        'MOCK_OTP',
        'Production must not set MOCK_OTP; the mock OTP provider is development/test only',
      );
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
