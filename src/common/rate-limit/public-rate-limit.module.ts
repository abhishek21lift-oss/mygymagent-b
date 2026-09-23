import { Global, Module } from '@nestjs/common';
import { PublicRateLimitService } from './public-rate-limit.service';

/** Global: every module with a `@Public()` device-credentialled endpoint
 * needs the same shared window, and there is exactly one of them. */
@Global()
@Module({
  providers: [PublicRateLimitService],
  exports: [PublicRateLimitService],
})
export class PublicRateLimitModule {}
