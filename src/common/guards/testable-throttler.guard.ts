import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';

@Injectable()
export class TestableThrottlerGuard implements CanActivate {
  canActivate(_context: ExecutionContext): boolean {
    if (process.env.TEST_MODE === 'true') {
      return true;
    }
    return false;
  }
}
