import {
  CanActivate,
  ExecutionContext,
  ValidationPipe,
  type INestApplication,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { AllExceptionsFilter } from '../../src/common/filters/all-exceptions.filter';

process.env.TEST_MODE = 'true';

class MockThrottlerGuard implements CanActivate {
  canActivate(_context: ExecutionContext): boolean {
    return true;
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
    })
      .overrideGuard(ThrottlerGuard)
      .useClass(MockThrottlerGuard)
      .compile();
    app = moduleRef.createNestApplication();

    app.use(cookieParser());
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        // Must mirror main.ts exactly, or the suite validates a pipe
        // configuration production does not run (B-P0-7).
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

/**
 * Gives an existing member an ACTIVE membership, so that
 * POST /attendance/check-in is actually allowed.
 *
 * AttendanceService#evaluateGate denies a check-in for a member with no
 * active membership, and the controller answers a denial with 200 + a
 * decision body rather than a 4xx (turnstiles need a decision, not an
 * error). A test that creates a bare member and expects 201 from a
 * check-in is therefore asserting against the pre-gate behaviour and
 * will fail on the 200 -- give the member a membership here instead of
 * relaxing the assertion, so the check-in under test is a real one.
 *
 * Goes through the public endpoints rather than writing rows directly:
 * POST /memberships already creates with status ACTIVE, startDate now
 * and endDate now + durationDays, which is exactly what the gate looks
 * for.
 */
export async function grantActiveMembership(
  app: INestApplication,
  accessToken: string,
  memberId: string,
  durationDays = 30,
): Promise<{ membershipId: string; membershipPlanId: string }> {
  const authed = (req: request.Test) =>
    req.set('Authorization', `Bearer ${accessToken}`);

  const plan = await authed(
    request(app.getHttpServer())
      .post('/membership-plans')
      .send({
        name: `Gate Pass ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        durationDays,
        price: 50,
      }),
  ).expect(201);

  const membership = await authed(
    request(app.getHttpServer()).post('/memberships').send({
      memberId,
      membershipPlanId: plan.body.data.id,
    }),
  ).expect(201);

  return {
    membershipId: membership.body.data.id,
    membershipPlanId: plan.body.data.id,
  };
}
