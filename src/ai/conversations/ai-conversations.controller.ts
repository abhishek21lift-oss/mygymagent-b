import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { RequirePermissions } from '../../common/decorators/permissions.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { AiConversationsService } from './ai-conversations.service';

/** AI memory's human-facing side -- a user's own past conversations
 * only (never another user's; see AiConversationsService's ownership
 * checks). Same `ai.generate` permission as /ai/chat itself: if you can
 * talk to the assistant, you can see your own history with it. */
@Controller('ai/conversations')
export class AiConversationsController {
  constructor(private readonly conversations: AiConversationsService) {}

  @Get()
  @RequirePermissions('ai.generate')
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: PaginationQueryDto,
  ) {
    return this.conversations.list(user.organizationId!, user.id, query);
  }

  @Get(':id')
  @RequirePermissions('ai.generate')
  getOne(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.conversations.getOne(user.organizationId!, user.id, id);
  }

  @Delete(':id')
  @RequirePermissions('ai.generate')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ): Promise<void> {
    await this.conversations.softDelete(user.organizationId!, user.id, id);
  }
}
