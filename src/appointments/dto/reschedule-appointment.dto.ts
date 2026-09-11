import { IsISO8601, IsOptional, IsString, MaxLength } from 'class-validator';
export class RescheduleAppointmentDto {
  @IsISO8601() startTime!: string;
  @IsISO8601() endTime!: string;
  @IsOptional() @IsString() @MaxLength(1000) reason?: string;
}
