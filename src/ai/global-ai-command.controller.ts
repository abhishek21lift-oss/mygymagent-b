import { Controller, Post, Body, UseGuards, Request } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { GlobalAiCommandService } from './global-ai-command.service';
import {
  GlobalCommandRequest,
  GlobalCommandResponse,
} from './global-ai-command.service';

/**
 * Global AI Command Interface (P3B): Provides a unified AI command interface
 * accessible from anywhere in the application.
 *
 * Security Features:
 * - Requires authentication (JWT)
 * - Tenant-aware (uses organizationId from user context)
 * - Role-aware (uses existing permission system)
 * - Routes through AI Supervisor for consistent access control
 * - Preserves audit trail through existing logging mechanisms
 * - Never provides unrestricted database access
 */
@Controller('global-ai')
@UseGuards(AuthGuard('jwt'))
export class GlobalAiCommandController {
  constructor(private readonly globalAiCommand: GlobalAiCommandService) {}

  @Post('command')
  async processCommand(
    @CurrentUser() user: AuthenticatedUser,
    @Body() request: GlobalCommandRequest,
  ): Promise<GlobalCommandResponse> {
    // Ensure the request contains the correct organization and user IDs from the authenticated context
    // This prevents users from spoofing organization/user IDs
    request.organizationId = user.organizationId!;
    request.userId = user.id;

    return this.globalAiCommand.processCommand(request);
  }
}
