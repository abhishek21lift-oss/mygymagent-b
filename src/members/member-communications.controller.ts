import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Audited } from '../common/decorators/audited.decorator';
import { CurrentAssignmentScope } from '../common/decorators/assignment-scope.decorator';
import { CurrentBranchScope } from '../common/decorators/branch-scope.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import {
  RequireAnyPermission,
  RequirePermissions,
} from '../common/decorators/permissions.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { SendMemberMessageDto } from './dto/send-member-message.dto';
import { MemberCommunicationsService } from './member-communications.service';

@Controller('members/:memberId/communications')
@Throttle({ default: { limit: 40, ttl: 60_000 } })
export class MemberCommunicationsController {
  constructor(private readonly communications: MemberCommunicationsService) {}

  @Get()
  @RequireAnyPermission('members.read', 'members.read_assigned')
  history(
    @CurrentUser() user: AuthenticatedUser,
    @Param('memberId') memberId: string,
    @CurrentBranchScope() branchScope: string | null,
    @CurrentAssignmentScope() assignmentScope: string | null,
  ) {
    return this.communications.history(
      user.organizationId!,
      memberId,
      branchScope,
      assignmentScope,
    );
  }

  @Post('send')
  @RequirePermissions('members.update')
  @Audited({ resource: 'member_message', action: 'send' })
  send(
    @CurrentUser() user: AuthenticatedUser,
    @Param('memberId') memberId: string,
    @Body() dto: SendMemberMessageDto,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.communications.send(
      user.organizationId!,
      memberId,
      dto,
      branchScope,
    );
  }
}
