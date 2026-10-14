import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { BranchFilterQueryDto } from '../../common/branch/branch-filter';

/** Inactivity window for the irregular-members preview. Omitted, the API
 * uses the gym's saved threshold (WhatsappProfile.irregularThresholdDays).
 * 1-90, matching the UI's presets plus its custom-day validation. */
export class IrregularMembersQueryDto extends BranchFilterQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(90)
  rangeDays?: number;
}
