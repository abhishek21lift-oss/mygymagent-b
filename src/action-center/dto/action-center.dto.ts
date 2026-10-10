import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsInt,
  IsOptional,
  IsUUID,
  Max,
  Min,
} from 'class-validator';

export class DayQueryDto {
  /** YYYY-MM-DD in the gym's timezone; today when unset. */
  @IsOptional()
  @IsDateString()
  date?: string;

  @IsOptional()
  @IsUUID()
  branchId?: string;

  @IsOptional()
  @IsUUID()
  assignedToUserId?: string;
}

export class UpdateActionCenterSettingsDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(6)
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(60, { each: true })
  renewalReminderDays?: number[];

  @IsOptional() @IsInt() @Min(0) @Max(90) expiredLookbackDays?: number;
  @IsOptional() @IsInt() @Min(1) @Max(60) duesFollowUpIntervalDays?: number;
  @IsOptional() @IsInt() @Min(3) @Max(180) inactiveDays?: number;
  @IsOptional() @IsInt() @Min(0) @Max(14) promiseGraceDays?: number;
  @IsOptional() @IsInt() @Min(0) @Max(72) newLeadContactHours?: number;
  @IsOptional() @IsInt() @Min(0) @Max(1440) reminderLeadMinutes?: number;
  @IsOptional() @IsInt() @Min(1) @Max(336) overdueEscalationHours?: number;
  @IsOptional() @IsInt() @Min(0) @Max(23) quietHoursStart?: number | null;
  @IsOptional() @IsInt() @Min(0) @Max(23) quietHoursEnd?: number | null;
  @IsOptional() @IsInt() @Min(1) @Max(1000) maxNewTasksPerSource?: number;
}
