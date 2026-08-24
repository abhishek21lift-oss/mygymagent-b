import './instrument';

import { ForbiddenException, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import type { Request, Response, NextFunction } from 'express';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  const config = app.get(ConfigService);

  app.use(helmet());
  app.use(compression());
  app.use(cookieParser());

  const allowedOrigins = config
    .get<string>('CORS_ORIGIN', 'http://localhost:3000')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  app.enableCors({
    origin: allowedOrigins,
    credentials: true,
  });

  // Cookie-authenticated endpoints are vulnerable to cross-site request
  // forgery even when CORS blocks reading the response. The refresh/logout
  // endpoints use the httpOnly refresh cookie, so require an Origin header
  // and accept it only from the same allowlist used by CORS. Bearer-token
  // endpoints remain unaffected. This is intentionally implemented at the
  // HTTP boundary so future auth-controller changes cannot accidentally
  // forget the CSRF check.
  app.use((req: Request, _res: Response, next: NextFunction) => {
    const cookieAuthenticatedEndpoint =
      req.method === 'POST' &&
      (req.path === '/auth/refresh' || req.path === '/auth/logout');

    if (!cookieAuthenticatedEndpoint || !req.cookies?.refresh_token) {
      return next();
    }

    const origin = req.headers.origin;
    if (!origin || !allowedOrigins.includes(origin)) {
      throw new ForbiddenException('Invalid request origin');
    }

    return next();
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());

  app.enableShutdownHooks();

  const port = config.get<number>('PORT', 4000);
  await app.listen(port);

  console.log(`MyGymAgent API listening on port ${port}`);
}

void bootstrap();
