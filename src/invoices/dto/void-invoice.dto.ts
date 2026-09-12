import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class VoidInvoiceDto {
  /** Why the invoice is being voided -- recorded in the audit trail, not
   * on the invoice row itself (a voided invoice keeps its issued figures
   * untouched). */
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}
