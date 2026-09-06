import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage } from '@nestjs/throttler';
import cookieParser from 'cookie-parser';
import { AppModule } from '../../src/app.module';
import { AllExceptionsFilter } from '../../src/common/filters/all-exceptions.filter';

let globalThrottlerStorage: ThrottlerStorage | null = null;

export function resetThrottlerStorage(): void {
  if (!globalThrottlerStorage) return;
  const storage = globalThrottlerStorage as {
    storage?: Map<string, unknown>;
    _storage?: Map<string, unknown>;
    timeoutIds?: Map<string, NodeJS.Timeout[]>;
    onApplicationShutdown?: () => void;
  };
  if (storage.storage) storage.storage.clear();
  if (storage._storage) storage._storage.clear();
  if (storage.timeoutIds) {
    storage.timeoutIds.forEach((t) => t.forEach(clearTimeout));
    storage.timeoutIds.clear();
  }
}

export async function resetThrottlerStorageAsync(): Promise<void> {
  if (!globalThrottlerStorage) return;
  const storage = globalThrottlerStorage as {
    storage?: Map<string, unknown>;
    _storage?: Map<string, unknown>;
    timeoutIds?: Map<string, NodeJS.Timeout[]>;
    onApplicationShutdown?: () => void;
  };
  try {
    if (storage.storage) storage.storage.clear();
  } catch {
    // Ignore errors
  }
  try {
    if (storage._storage) storage._storage.clear();
  } catch {
    // Ignore errors
  }
  try {
    if (storage.timeoutIds) {
      storage.timeoutIds.forEach((t) => {
        try {
          t.forEach(clearTimeout);
        } catch {
          // Ignore
        }
      });
      storage.timeoutIds.clear();
    }
  } catch {
    // Ignore errors
  }
  try {
    if (storage.onApplicationShutdown) storage.onApplicationShutdown();
  } catch {
    // Ignore errors
  }
}

/** Builds a fully-wired Nest application (same global pipes/filters/
 * middleware as main.ts) for supertest to exercise, without binding to a real
 * port. Returns an object with the app and a safe close method. */
export async function createTestApp(): Promise<{
  app: INestApplication;
  close: () => Promise<void>;
}> {
  let app: INestApplication | undefined;

  const close = async () => {
    if (app) {
      try {
        await app.close();
      } catch {
        // Ignore errors during cleanup
      }
    }
  };

  try {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();

    app.use(cookieParser());
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    );
    app.useGlobalFilters(new AllExceptionsFilter());

    await app.init();

    if (!globalThrottlerStorage) {
      try {
        globalThrottlerStorage = app.get(ThrottlerStorage, { strict: false });
      } catch {
        // ThrottlerStorage not available
      }
    }

    return { app, close };
  } catch (error) {
    await close();
    throw error;
  }
}

export interface RegisteredAccount {
  accessToken: string;
  organizationId: string;
  userId: string;
  branchId: string;
}
