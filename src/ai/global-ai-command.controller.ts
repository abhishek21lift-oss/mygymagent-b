import { Controller, Post, Body, UseGuards } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Throttle } from '@nestjs/throttler';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { GlobalAiCommandService } from './global-ai-command.service';
import type { GlobalCommandResponse } from './global-ai-command.service';
import { GlobalCommandDto } from './dto/global-command.dto';

/**
 * Global AI Command Interface (P3B): Provides a unified AI command interface
 * accessible from anywhere in the application.
 *
 * Security Features:
 * - Requires authentication (JWT) + ai.generate permission
 * - Tenant-aware (uses organizationId from user context)
 * - Role-aware (uses existing permission system)
 * - Routes through AI Supervisor for consistent access control
 * - Preserves audit trail through existing logging mechanisms
 * - Never provides unrestricted database access
 */
@Controller('global-ai')
@UseGuards(AuthGuard('jwt'))
@Throttle({ default: { limit: 20, ttl: 60_000 } })
export class GlobalAiCommandController {
  constructor(private readonly globalAiCommand: GlobalAiCommandService) {}

  @Post('command')
  @RequirePermissions('ai.generate')
  async processCommand(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: GlobalCommandDto,
  ): Promise<GlobalCommandResponse> {
    // The organization and user come from the session, never the body.
    return this.globalAiCommand.processCommand({
      organizationId: user.organizationId!,
      userId: user.id,
      command: dto.command,
      context: dto.context,
    });
  }
}
