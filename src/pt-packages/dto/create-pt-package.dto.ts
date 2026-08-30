import {
  IsDateString,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Min,
} from 'class-validator';

export class CreatePtPackageDto {
  @IsUUID() memberId!: string;
  @IsUUID() branchId!: string;
  @IsOptional() @IsUUID() templateId?: string;
  @IsString() name!: string;
  @IsInt() @Min(1) totalSessions!: number;
  @IsDateString() startDate!: string;
  @IsDateString() endDate!: string;
  @IsNumber() @Min(0) price!: number;
  @IsOptional() @IsString() currency?: string;
}
