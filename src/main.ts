import './instrument';

import { ValidationPipe, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { json } from 'express';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import type { NextFunction, Request, Response } from 'express';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';

async function bootstrap() {
  // `bodyParser: false` + our own `json()` for one reason: the member CSV
  // import accepts up to 2,000 rows (400KB+ of JSON), which the Express
  // default 100kb limit rejected with a 413 before ValidationPipe ever
  // saw a row. 1mb covers a full import with headroom while keeping a
  // bound on how much any request can buffer.
  //
  // The `verify` callback preserves what `rawBody: true` used to expose:
  // the untouched bytes webhook signature verification needs (Razorpay's
  // HMAC over the raw body, Stripe's constructEvent) -- parsing and
  // re-serializing would change those bytes and break verification.
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  app.use(
    json({
      limit: '1mb',
      verify: (req, _res, buf) => {
        (req as Request & { rawBody?: Buffer }).rawBody = buf;
      },
    }),
  );
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

  // The API answers on its own public host; nothing it serves belongs in
  // search results, so tell crawlers that on every response.
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    next();
  });

  app.use(compression());
  app.use(cookieParser());

  const configuredCors = config.get<string>('CORS_ORIGIN');
  if (isProduction && !configuredCors) {
    // Fail fast rather than silently pinning production CORS to a hardcoded
    // origin that may not match the deployed frontend. Nothing below can
    // supply a production origin, so this is the only correct behaviour.
    throw new Error(
      'CORS_ORIGIN must be set in production (comma-separated allowed origins).',
    );
  }
  // Development only. There is deliberately no production fallback: the
  // throw above means `configuredCors` is always set in prod, and a
  // hardcoded host here would only ever be dead code that reads like a
  // guarantee. Real deployments set CORS_ORIGIN to every origin that serves
  // the frontend -- including the Capacitor WebView origin for the native
  // build, which is not necessarily the same host as the website.
  const devFallbackCors = 'http://localhost:3000,http://localhost:5173';
  const origins = (configuredCors ?? devFallbackCors)
    .split(',')
    .map((origin) => origin.trim().replace(/\/$/, ''))
    .filter(Boolean);

  if (!configuredCors) {
    logger.warn(
      `CORS_ORIGIN is not configured; using development fallback: ${origins.join(', ')}`,
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
