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
import { Throttle } from '@nestjs/throttler';
import { Audited } from '../common/decorators/audited.decorator';
import { CurrentBranchScope } from '../common/decorators/branch-scope.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import {
  CreateExpenseDto,
  ExpenseSummaryQueryDto,
  ListExpensesQueryDto,
  RejectExpenseDto,
  UpdateExpenseDto,
} from './dto/expense.dto';
import { ExpensesService } from './expenses.service';

/// NOTE on route registration order: `summary` is declared before
/// `:id` so Express never matches it as an expense id.
@Controller('expenses')
@Throttle({ default: { limit: 40, ttl: 60_000 } })
export class ExpensesController {
  constructor(private readonly expenses: ExpensesService) {}

  @Get('summary')
  @RequirePermissions('expenses.read')
  getSummary(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ExpenseSummaryQueryDto,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.expenses.getSummary(user.organizationId!, query, branchScope);
  }

  @Get()
  @RequirePermissions('expenses.read')
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: ListExpensesQueryDto,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.expenses.list(user.organizationId!, query, branchScope);
  }

  @Get(':id')
  @RequirePermissions('expenses.read')
  getOne(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.expenses.getOne(user.organizationId!, id, branchScope);
  }

  @Post()
  @RequirePermissions('expenses.create')
  @Audited({ resource: 'expense', action: 'create' })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateExpenseDto,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.expenses.create(
      user.organizationId!,
      dto,
      user.id,
      branchScope,
    );
  }

  @Patch(':id')
  @RequirePermissions('expenses.update')
  @Audited({ resource: 'expense', action: 'update' })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: UpdateExpenseDto,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.expenses.update(user.organizationId!, id, dto, branchScope);
  }

  @Post(':id/approve')
  @RequirePermissions('expenses.update')
  @Audited({ resource: 'expense', action: 'approve' })
  approve(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.expenses.approve(
      user.organizationId!,
      id,
      user.id,
      branchScope,
    );
  }

  @Post(':id/reject')
  @RequirePermissions('expenses.update')
  @Audited({ resource: 'expense', action: 'reject' })
  reject(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body() dto: RejectExpenseDto,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.expenses.reject(
      user.organizationId!,
      id,
      dto,
      user.id,
      branchScope,
    );
  }

  @Post(':id/mark-paid')
  @RequirePermissions('expenses.update')
  @Audited({ resource: 'expense', action: 'mark_paid' })
  markPaid(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.expenses.markPaid(user.organizationId!, id, branchScope);
  }

  @Delete(':id')
  @RequirePermissions('expenses.delete')
  @Audited({ resource: 'expense', action: 'delete' })
  remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @CurrentBranchScope() branchScope: string | null,
  ) {
    return this.expenses.remove(user.organizationId!, id, branchScope);
  }
}
