import {
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateClassProgramDto {
  @IsUUID() branchId!: string;
  @IsString() @MaxLength(120) name!: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsInt() @Min(1) @Max(500) capacity!: number;
  @IsInt() @Min(1) @Max(600) durationMinutes!: number;
  @IsOptional() @IsUUID() instructorId?: string;
}
export class CreateClassSessionDto {
  @IsUUID() branchId!: string;
  @IsUUID() classProgramId!: string;
  @IsOptional() @IsUUID() instructorId?: string;
  @IsDateString() startTime!: string;
  @IsDateString() endTime!: string;
  @IsOptional() @IsInt() @Min(1) @Max(500) capacity?: number;
}
export class ListClassSessionsDto {
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
  @IsOptional() @IsUUID() branchId?: string;
  @IsOptional() @IsUUID() instructorId?: string;
}
export class BookClassDto {
  @IsUUID() memberId!: string;
}
export class ClassAttendanceDto {
  @IsIn(['ATTENDED', 'NO_SHOW']) status!: 'ATTENDED' | 'NO_SHOW';
}
export class ListClassesDto {
  @IsOptional() @IsUUID() branchId?: string;
  @IsOptional() @IsIn(['ACTIVE', 'INACTIVE']) status?: 'ACTIVE' | 'INACTIVE';
}
