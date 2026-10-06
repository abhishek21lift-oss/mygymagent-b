import { IsISO8601, IsNotEmpty } from 'class-validator';

export class SnoozeNotificationDto {
  @IsNotEmpty()
  @IsISO8601()
  until!: string;
}
