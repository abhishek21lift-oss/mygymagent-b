import { IsEmail, IsIn, IsISO8601, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';

export class CreateAppointmentDto {
  @IsUUID() branchId!: string;
  @IsOptional() @IsUUID() staffId?: string;
  @IsOptional() @IsUUID() memberId?: string;
  @IsOptional() @IsUUID() leadId?: string;
  @IsIn(['TRIAL', 'CONSULTATION', 'ASSESSMENT', 'FOLLOW_UP', 'PT_SESSION', 'OTHER']) type!: string;
  @IsString() @MaxLength(200) title!: string;
  @IsISO8601() startTime!: string;
  @IsISO8601() endTime!: string;
  @IsOptional() @IsString() @MaxLength(5000) notes?: string;
  @IsOptional() @IsString() @MaxLength(200) clientName?: string;
  @IsOptional() @IsEmail() clientEmail?: string;
  @IsOptional() @IsString() @MaxLength(40) clientPhone?: string;
}
