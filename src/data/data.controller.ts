import { Body, Controller, Get, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { DataService } from './data.service';

@Controller('data')
export class DataController {
  constructor(private readonly data: DataService) {}

  @Get('members/export')
  @RequirePermissions('data.export')
  async exportMembers(
    @CurrentUser() u: AuthenticatedUser,
    @Res() res: Response,
  ) {
    const csv = await this.data.exportMembers(u.organizationId!);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="members.csv"');
    res.send(csv);
  }

  @Get('members/template')
  @RequirePermissions('data.export')
  template(@Res() res: Response) {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.send(
      'firstName,lastName,email,phone,dateOfBirth,gender,status,primaryBranchId,assignedTrainerId\n',
    );
  }

  @Post('members/import')
  @RequirePermissions('data.import')
  importMembers(
    @CurrentUser() u: AuthenticatedUser,
    @Body() body: { rows: Record<string, string>[] },
  ) {
    return this.data.importMembers(u.organizationId!, body.rows ?? []);
  }
}
