import { Module } from '@nestjs/common';
import { PlatformBillingModule } from '../platform-billing/platform-billing.module';
import { CommunicationsModule } from '../communications/communications.module';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  imports: [CommunicationsModule, PlatformBillingModule],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
