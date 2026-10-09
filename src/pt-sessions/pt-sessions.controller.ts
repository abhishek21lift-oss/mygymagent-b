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
import { CurrentBranchScope } from '../common/decorators/branch-scope.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { CurrentAssignmentScope } from '../common/decorators/assignment-scope.decorator';
import {
  AssignedOnlyUnless,
  RequirePermissions,
} from '../common/decorators/permissions.decorator';
import { ListPtSessionsDto } from './dto/list-pt-sessions.dto';
import { Audited } from '../common/decorators/audited.decorator';
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

  /**
   * One DTO for the whole query string.
   *
   * This took `@Query() PaginationQueryDto` plus five separate
   * `@Query('...')` params. The global pipe runs with
   * `forbidNonWhitelisted: true` and validates the entire query object
   * against the DTO, which declared none of those five -- so every
   * request that actually used one was rejected before the handler ran.
   * `GET /pt-sessions?memberId=x` answered 400 in production, which is
   * the PT panel on every member's page.
   */
  @Get()
  @RequirePermissions('pt-sessions.read')
  async list(
    @Query() query: ListPtSessionsDto,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.ptSessionsService.list(
      requireOrgId(user),
      query,
      query.memberId,
      query.trainerId,
      query.branchId,
      query.startFrom ? new Date(query.startFrom) : undefined,
      query.endTo ? new Date(query.endTo) : undefined,
      branchScope,
    );
  }

  @Get(':id')
  @RequirePermissions('pt-sessions.read')
  async getOne(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.ptSessionsService.getOne(requireOrgId(user), id, branchScope);
  }

  @Post()
  @RequirePermissions('pt-sessions.create')
  @AssignedOnlyUnless('pt-sessions.read')
  @Audited({ resource: 'pt_session', action: 'book' })
  async book(
    @Body() dto: BookPtSessionDto,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentAssignmentScope() assignmentScope: string | null,
  ) {
    return this.ptSessionsService.book(
      requireOrgId(user),
      dto,
      user.id,
      assignmentScope,
    );
  }

  @Patch(':id')
  @RequirePermissions('pt-sessions.update')
  @AssignedOnlyUnless('pt-sessions.read')
  @Audited({ resource: 'pt_session', action: 'update' })
  async update(
    @Param('id') id: string,
    @Body() dto: UpdatePtSessionDto,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentAssignmentScope() assignmentScope: string | null,
  ) {
    return this.ptSessionsService.update(
      requireOrgId(user),
      id,
      dto,
      user.id,
      assignmentScope,
    );
  }

  @Patch(':id/complete')
  @RequirePermissions('pt-sessions.update')
  @AssignedOnlyUnless('pt-sessions.read')
  @Audited({ resource: 'pt_session', action: 'complete' })
  async complete(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentAssignmentScope() assignmentScope: string | null,
  ) {
    return this.ptSessionsService.complete(
      requireOrgId(user),
      id,
      user.id,
      assignmentScope,
    );
  }

  @Patch(':id/cancel')
  @RequirePermissions('pt-sessions.update')
  @AssignedOnlyUnless('pt-sessions.read')
  @Audited({ resource: 'pt_session', action: 'cancel' })
  async cancel(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentAssignmentScope() assignmentScope: string | null,
    @Query('reason') cancellationReason?: string,
  ) {
    return this.ptSessionsService.cancel(
      requireOrgId(user),
      id,
      user.id,
      cancellationReason,
      assignmentScope,
    );
  }

  @Patch(':id/no-show')
  @RequirePermissions('pt-sessions.update')
  @AssignedOnlyUnless('pt-sessions.read')
  @Audited({ resource: 'pt_session', action: 'no-show' })
  async markNoShow(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentAssignmentScope() assignmentScope: string | null,
  ) {
    return this.ptSessionsService.markNoShow(
      requireOrgId(user),
      id,
      user.id,
      assignmentScope,
    );
  }
}
