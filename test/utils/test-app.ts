import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import { AppModule } from '../../src/app.module';
import { AllExceptionsFilter } from '../../src/common/filters/all-exceptions.filter';

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
