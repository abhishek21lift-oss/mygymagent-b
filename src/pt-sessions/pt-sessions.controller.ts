import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseInterceptors,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { AuditInterceptor } from '../common/interceptors/audit.interceptor';
import { CurrentUser as CurrentUserType } from '../common/types/authenticated-user';
import { PtSessionsService } from './pt-sessions.service';
import { BookPtSessionDto } from './dto/book-pt-session.dto';
import { UpdatePtSessionDto } from './dto/update-pt-session.dto';

@ApiTags('pt-sessions')
@Controller('pt-sessions')
@UseInterceptors(AuditInterceptor)
export class PtSessionsController {
  constructor(private readonly ptSessionsService: PtSessionsService) {}

  @Get()
  @RequirePermissions('pt-sessions.read')
  async list(
    @Query() query: PaginationQueryDto,
    @Query('memberId') memberId?: string,
    @Query('trainerId') trainerId?: string,
    @Query('branchId') branchId?: string,
    @Query('startFrom') startFrom?: string,
    @Query('endTo') endTo?: string,
    @CurrentUser() user: CurrentUserType,
  ) {
    return this.ptSessionsService.list(
      user.organizationId,
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
  async getOne(@Param('id') id: string, @CurrentUser() user: CurrentUserType) {
    return this.ptSessionsService.getOne(user.organizationId, id);
  }

  @Post()
  @RequirePermissions('pt-sessions.create')
  async book(
    @Body() dto: BookPtSessionDto,
    @CurrentUser() user: CurrentUserType,
  ) {
    return this.ptSessionsService.book(user.organizationId, dto, user.id);
  }

  @Patch(':id')
  @RequirePermissions('pt-sessions.update')
  async update(
    @Param('id') id: string,
    @Body() dto: UpdatePtSessionDto,
    @CurrentUser() user: CurrentUserType,
  ) {
    return this.ptSessionsService.update(user.organizationId, id, dto, user.id);
  }

  @Patch(':id/complete')
  @RequirePermissions('pt-sessions.update')
  async complete(
    @Param('id') id: string,
    @CurrentUser() user: CurrentUserType,
  ) {
    return this.ptSessionsService.complete(user.organizationId, id, user.id);
  }

  @Patch(':id/cancel')
  @RequirePermissions('pt-sessions.update')
  async cancel(
    @Param('id') id: string,
    @CurrentUser() user: CurrentUserType,
    @Query('reason') cancellationReason?: string,
  ) {
    return this.ptSessionsService.cancel(
      user.organizationId,
      id,
      user.id,
      cancellationReason,
    );
  }

  @Patch(':id/no-show')
  @RequirePermissions('pt-sessions.update')
  async markNoShow(
    @Param('id') id: string,
    @CurrentUser() user: CurrentUserType,
  ) {
    return this.ptSessionsService.markNoShow(user.organizationId, id, user.id);
  }
}
