import { IsDateString, IsString } from 'class-validator';

export class CreateFollowUpDto {
  @IsDateString()
  dueAt!: string;

  @IsString()
  note!: string;
}
