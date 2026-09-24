import { IsArray, IsBoolean, IsOptional, IsUUID } from 'class-validator';
import { ToBoolean } from '../../common/transforms/to-boolean.transform';
import type { EnquiryRow } from '../customer-enquiry-mapping';

export class ImportCustomerEnquiryDto {
  /** The export's rows, each keyed by its column heading. */
  @IsArray()
  rows!: EnquiryRow[];

  /** Required only when the organization has more than one branch. */
  @IsOptional()
  @IsUUID()
  branchId?: string;

  /** Report what would happen and write nothing. */
  @IsOptional()
  @ToBoolean()
  @IsBoolean()
  dryRun?: boolean;
}
