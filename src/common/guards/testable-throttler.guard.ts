import { Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  InjectThrottlerOptions,
  InjectThrottlerStorage,
  ThrottlerGuard,
  type ThrottlerModuleOptions,
  type ThrottlerStorage,
} from '@nestjs/throttler';

/**
 * Test-aware wrapper around Nest's real throttler guard.
 *
 * E2E tests set TEST_MODE=true so rate limiting does not make the test suite
 * flaky. Production and all non-test environments MUST use the real
 * ThrottlerGuard; returning false here would make every request fail with 403.
 */
@Injectable()
export class TestableThrottlerGuard extends ThrottlerGuard {
  constructor(
    @InjectThrottlerOptions() options: ThrottlerModuleOptions,
    @InjectThrottlerStorage() storage: ThrottlerStorage,
    reflector: Reflector,
  ) {
    super(options, storage, reflector);
  }

  canActivate(context: import('@nestjs/common').ExecutionContext) {
    if (process.env.TEST_MODE === 'true') {
      return true;
    }
    return super.canActivate(context);
  }
}
