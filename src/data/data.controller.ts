import { Body, Controller, Get, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermissions } from '../common/decorators/permissions.decorator';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { DataService } from './data.service';
import { CustomerEnquiryImportService } from './customer-enquiry-import.service';
import { ImportCustomerEnquiryDto } from './dto/import-customer-enquiry.dto';
import { Audited } from '../common/decorators/audited.decorator';

@Controller('data')
export class DataController {
  constructor(
    private readonly data: DataService,
    private readonly enquiryImport: CustomerEnquiryImportService,
  ) {}

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

  /**
   * Imports a "Customer Enquiry" export -- the shape other gym systems
   * hand over, with one sheet mixing converted members and prospects.
   *
   * Send `dryRun: true` first. The report is the same either way, so
   * what you read is what the committing run will do.
   */
  @Post('imports/customer-enquiry')
  @RequirePermissions('data.import')
  @Audited({ resource: 'customer_enquiry_import', action: 'run' })
  importCustomerEnquiry(
    @CurrentUser() u: AuthenticatedUser,
    @Body() dto: ImportCustomerEnquiryDto,
  ) {
    return this.enquiryImport.import(u.organizationId!, dto.rows, {
      dryRun: dto.dryRun ?? false,
      branchId: dto.branchId,
    });
  }
}
