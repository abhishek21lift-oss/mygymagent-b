import { ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  ThrottlerGuard,
  getOptionsToken,
  getStorageToken,
} from '@nestjs/throttler';
import type {
  ThrottlerModuleOptions,
  ThrottlerStorage,
} from '@nestjs/throttler';

@Injectable()
export class TestableThrottlerGuard extends ThrottlerGuard {
  constructor(
    @Inject(getOptionsToken()) options: ThrottlerModuleOptions,
    @Inject(getStorageToken()) storage: ThrottlerStorage,
    reflector: Reflector,
  ) {
    super(options, storage, reflector);
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // E2E-only bypass. Never disable throttling in production — even if
    // TEST_MODE is accidentally set there (e.g. copied .env.test).
    if (
      process.env.NODE_ENV !== 'production' &&
      process.env.TEST_MODE === 'true'
    ) {
      return true;
    }
    return super.canActivate(context);
  }
}
