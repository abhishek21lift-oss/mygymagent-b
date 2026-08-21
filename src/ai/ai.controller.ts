import { Body, Controller, Post } from '@nestjs/common';
import { Audited } from '../common/decorators/audited.decorator';
import { RequestedBranchId } from '../common/decorators/branch-id.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { AiService } from './ai.service';
import { ChatDto } from './dto/chat.dto';

@Controller('ai')
export class AiController {
  constructor(private readonly aiService: AiService) {}

  @Post('chat')
  @RequirePermissions('ai.generate')
  @Audited({ resource: 'ai_chat', action: 'chat' })
  chat(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ChatDto,
    @RequestedBranchId() requestedBranchId: string | undefined,
  ) {
    // `ai.generate` only gates this endpoint -- it says nothing about
    // whether the caller may read a given member/lead/attendance record,
    // the same way `members.read` says nothing about `payments.read`. The
    // raw branch header is forwarded, unverified, exactly like
    // `@RequestedBranchId()` everywhere else; ToolExecutorService
    // reconciles it against the caller's real grants per tool call before
    // it can restrict (or fail to restrict) anything -- see that service's
    // class comment.
    return this.aiService.chat(
      user.organizationId!,
      user.id,
      dto,
      requestedBranchId,
    );
  }
}
