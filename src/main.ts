import './instrument';

import { ValidationPipe, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';

async function bootstrap() {
  // `rawBody: true` exposes the untouched request bytes as
  // `request.rawBody` for webhook signature verification (Razorpay's
  // `x-razorpay-signature` is HMAC-SHA256 over the raw body -- parsing
  // then re-serializing would change the bytes and break verification).
  const app = await NestFactory.create(AppModule, {
    rawBody: true,
  });
  const config = app.get(ConfigService);
  const isProduction = config.get('NODE_ENV') === 'production';
  const logger = new Logger('Main');

  // Trust the first proxy hop so `req.ip` / throttler see the real client
  // IP from X-Forwarded-For (Render/Vercel edge → app). Without this, all
  // proxied auth requests share one rate-limit bucket.
  app.getHttpAdapter().getInstance().set('trust proxy', 1);

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          styleSrc: [
            "'self'",
            "'unsafe-inline'",
            'https://cdnjs.cloudflare.com',
          ],
          scriptSrc: ["'self'", 'https://cdnjs.cloudflare.com'],
          imgSrc: ["'self'", 'data:', 'https:'],
          fontSrc: ["'self'", 'https://cdnjs.cloudflare.com'],
          connectSrc: isProduction
            ? ["'self'", 'https:']
            : [
                "'self'",
                'https:',
                'http://localhost:3000',
                'http://localhost:5173',
              ],
          frameSrc: ["'none'"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
        },
      },
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
      crossOriginEmbedderPolicy: false,
      crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      dnsPrefetchControl: { allow: false },
      frameguard: { action: 'deny' },
      hidePoweredBy: true,
      hsts: isProduction
        ? { maxAge: 31536000, includeSubDomains: true, preload: true }
        : false,
      ieNoOpen: true,
      noSniff: true,
      permittedCrossDomainPolicies: { permittedPolicies: 'none' },
      xssFilter: true,
    }),
  );

  app.use(compression());
  app.use(cookieParser());

  const configuredCors = config.get<string>('CORS_ORIGIN');
  const fallbackCors = isProduction
    ? 'https://mygymagent-f.vercel.app'
    : 'http://localhost:3000,http://localhost:5173';
  if (isProduction && !configuredCors) {
    // Fail fast rather than silently pinning production CORS to a hardcoded
    // origin that may not match the deployed frontend.
    throw new Error(
      'CORS_ORIGIN must be set in production (comma-separated allowed origins).',
    );
  }
  const origins = (configuredCors || fallbackCors)
    .split(',')
    .map((origin) => origin.trim().replace(/\/$/, ''))
    .filter(Boolean);

  if (!configuredCors) {
    logger.warn(
      `CORS_ORIGIN is not configured; using safe fallback: ${origins.join(', ')}`,
    );
  }

  app.enableCors({
    origin: origins,
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Device-Name',
      'X-Request-Id',
      'x-branch-id',
    ],
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      // No `enableImplicitConversion` (B-P0-7). class-transformer's
      // implicit boolean conversion is `Boolean(value)`, so the string
      // "false" -- which is what a query param always is, and what a
      // sloppy client sends in JSON -- became `true`, and `@IsBoolean()`
      // never saw a value it could reject. A client opting *out* of
      // something was silently opted *in*.
      //
      // Without it, JSON body fields arrive with their real JSON types and
      // the validators are the actual gate. Query params are always
      // strings, so a DTO bound to `@Query()` must convert explicitly:
      // `@Type(() => Number)` for numerics, `@ToBoolean()` from
      // `common/transforms/` for booleans.
    }),
  );
  app.useGlobalInterceptors(new LoggingInterceptor());
  app.useGlobalFilters(new AllExceptionsFilter());
  app.enableShutdownHooks();

  const port = config.get<number>('PORT', 4000);
  await app.listen(port);
  logger.log(`The Cult Client API listening on port ${port}`);
}

process.on('unhandledRejection', (reason) => {
  // Log loudly but let the process keep serving; fail-fast exit would drop
  // in-flight requests during a transient DB/Redis blip.
  console.error('[fatal] unhandledRejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[fatal] uncaughtException:', err);
  process.exit(1);
});

bootstrap().catch((err) => {
  console.error('[fatal] bootstrap failed:', err);
  process.exit(1);
});
