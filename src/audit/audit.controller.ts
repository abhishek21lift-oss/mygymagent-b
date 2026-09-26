import { Controller, Get, Query } from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { AuditService } from './audit.service';
import { ListAuditLogsDto } from './dto/list-audit-logs.dto';

/**
 * The read side of `audit.read`.
 *
 * Every mutating handler annotated with @Audited() has been writing
 * AuditLog rows since the beginning, and nothing could read one back --
 * so the gym recorded who changed what and could never look at it, which
 * is the entire point of keeping the trail.
 */
@Controller('audit-logs')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @RequirePermissions('audit.read')
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListAuditLogsDto,
  ) {
    return this.audit.list(user.organizationId!, query);
  }

  /** The distinct resources and actions present, so the filters offer what
   * this organization has actually done rather than a hardcoded guess. */
  @Get('facets')
  @RequirePermissions('audit.read')
  facets(@CurrentUser() user: AuthenticatedUser) {
    return this.audit.facets(user.organizationId!);
  }
}
