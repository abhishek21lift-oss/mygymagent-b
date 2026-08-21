import { Body, Controller, Get, Param, Patch, Query } from '@nestjs/common';
import { Audited } from '../common/decorators/audited.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { DietAssignmentsService } from './diet-assignments.service';
import { ListDietAssignmentsQueryDto } from './dto/list-diet-assignments-query.dto';
import { UpdateDietAssignmentStatusDto } from './dto/update-diet-assignment-status.dto';

@Controller('diet-assignments')
export class DietAssignmentsController {
  constructor(
    private readonly dietAssignmentsService: DietAssignmentsService,
  ) {}

  @Get()
  @RequirePermissions('nutrition.read')
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListDietAssignmentsQueryDto,
  ) {
    return this.dietAssignmentsService.list(
      user.organizationId!,
      query,
      query.memberId,
    );
  }

  @Patch(':id/status')
  @RequirePermissions('nutrition.assign')
  @Audited({ resource: 'diet_assignment', action: 'update_status' })
  updateStatus(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateDietAssignmentStatusDto,
  ) {
    return this.dietAssignmentsService.updateStatus(
      user.organizationId!,
      id,
      dto,
    );
  }
}
