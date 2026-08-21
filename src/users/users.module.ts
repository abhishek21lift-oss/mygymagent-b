import { Module } from '@nestjs/common';
import { CommunicationsModule } from '../communications/communications.module';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  imports: [CommunicationsModule],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
