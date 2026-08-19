import { Module } from '@nestjs/common';
import { MailerService } from '../common/mailer/mailer.service';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  controllers: [UsersController],
  providers: [UsersService, MailerService],
  exports: [UsersService],
})
export class UsersModule {}
