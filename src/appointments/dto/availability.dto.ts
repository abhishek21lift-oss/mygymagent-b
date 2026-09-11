import { IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
export class AvailabilityDto {
  @IsUUID() staffId!: string;
  @IsOptional() @IsUUID() branchId?: string;
  @IsInt() @Min(0) @Max(6) dayOfWeek!: number;
  @IsInt() @Min(0) @Max(1439) startMinute!: number;
  @IsInt() @Min(1) @Max(1440) endMinute!: number;
}
