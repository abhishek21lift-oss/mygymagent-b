import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseInterceptors,
} from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { AuditInterceptor } from '../common/interceptors/audit.interceptor';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { PtSessionsService } from './pt-sessions.service';
import { BookPtSessionDto } from './dto/book-pt-session.dto';
import { UpdatePtSessionDto } from './dto/update-pt-session.dto';

function requireOrgId(user: AuthenticatedUser): string {
  if (!user.organizationId) {
    throw new BadRequestException('Organization context is required');
  }
  return user.organizationId;
}

@Controller('pt-sessions')
@UseInterceptors(AuditInterceptor)
export class PtSessionsController {
  constructor(private readonly ptSessionsService: PtSessionsService) {}

  @Get()
  @RequirePermissions('pt-sessions.read')
  async list(
    @Query() query: PaginationQueryDto,
    @CurrentUser() user: AuthenticatedUser,
    @Query('memberId') memberId?: string,
    @Query('trainerId') trainerId?: string,
    @Query('branchId') branchId?: string,
    @Query('startFrom') startFrom?: string,
    @Query('endTo') endTo?: string,
  ) {
    return this.ptSessionsService.list(
      requireOrgId(user),
      query,
      memberId,
      trainerId,
      branchId,
      startFrom ? new Date(startFrom) : undefined,
      endTo ? new Date(endTo) : undefined,
    );
  }

  @Get(':id')
  @RequirePermissions('pt-sessions.read')
  async getOne(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.ptSessionsService.getOne(requireOrgId(user), id);
  }

  @Post()
  @RequirePermissions('pt-sessions.create')
  async book(@Body() dto: BookPtSessionDto, @CurrentUser() user: AuthenticatedUser) {
    return this.ptSessionsService.book(requireOrgId(user), dto, user.id);
  }

  @Patch(':id')
  @RequirePermissions('pt-sessions.update')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdatePtSessionDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.ptSessionsService.update(requireOrgId(user), id, dto, user.id);
  }

  @Patch(':id/complete')
  @RequirePermissions('pt-sessions.update')
  async complete(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.ptSessionsService.complete(requireOrgId(user), id, user.id);
  }

  @Patch(':id/cancel')
  @RequirePermissions('pt-sessions.update')
  async cancel(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Query('reason') cancellationReason?: string,
  ) {
    return this.ptSessionsService.cancel(requireOrgId(user), id, user.id, cancellationReason);
  }

  @Patch(':id/no-show')
  @RequirePermissions('pt-sessions.update')
  async markNoShow(@Param('id') id: string, @CurrentUser() user: AuthenticatedUser) {
    return this.ptSessionsService.markNoShow(requireOrgId(user), id, user.id);
  }
}
