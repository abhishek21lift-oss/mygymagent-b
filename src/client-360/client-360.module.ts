import { Module } from '@nestjs/common';
import { MembersModule } from '../members/members.module';
import { Client360Controller } from './client-360.controller';
import { Client360Service } from './client-360.service';

@Module({
  imports: [MembersModule],
  controllers: [Client360Controller],
  providers: [Client360Service],
})
export class Client360Module {}
