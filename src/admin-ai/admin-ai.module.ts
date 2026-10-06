import { Module } from '@nestjs/common';
import { AdminAiController } from './admin-ai.controller';
import { AdminAiService } from './admin-ai.service';
import { FreellmClient } from './freellm.client';

@Module({
  controllers: [AdminAiController],
  providers: [AdminAiService, FreellmClient],
})
export class AdminAiModule {}
