import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { ManageMessageTemplateDto } from './dto/manage-message-template.dto';
import { MessageTemplateService } from './message-template.service';
import { PrismaService } from '../prisma/prisma.service';

@Controller('communications')
export class CommunicationsController {
  constructor(
    private readonly templates: MessageTemplateService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('templates')
  @RequirePermissions('notifications.manage')
  listTemplates(@CurrentUser() user: AuthenticatedUser) {
    return this.templates.listOrganizationTemplates(user.organizationId!);
  }

  @Post('templates')
  @RequirePermissions('notifications.manage')
  createTemplate(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ManageMessageTemplateDto,
  ) {
    return this.templates.createOrganizationTemplate(user.organizationId!, dto);
  }

  @Patch('templates/:id')
  @RequirePermissions('notifications.manage')
  updateTemplate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: ManageMessageTemplateDto,
  ) {
    return this.templates.updateOrganizationTemplate(
      user.organizationId!,
      id,
      dto,
    );
  }

  @Delete('templates/:id')
  @RequirePermissions('notifications.manage')
  deleteTemplate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
  ) {
    return this.templates.deleteOrganizationTemplate(user.organizationId!, id);
  }

  @Get('logs')
  @RequirePermissions('notifications.manage')
  logs(
    @CurrentUser() user: AuthenticatedUser,
    @Query('limit') rawLimit?: string,
  ) {
    const limit = Math.min(
      Math.max(Number.parseInt(rawLimit ?? '100', 10) || 100, 1),
      250,
    );
    return this.prisma.messageLog.findMany({
      where: { organizationId: user.organizationId! },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }
}
