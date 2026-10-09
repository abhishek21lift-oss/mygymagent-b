import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  Matches,
  Max,
  Min,
} from 'class-validator';

const HH_MM_24H = /^([01]\d|2[0-3]):[0-5]\d$/;

export const CHANNEL_OVERRIDES = ['AUTO', 'WHATSAPP', 'EMAIL'] as const;
export type ChannelOverride = (typeof CHANNEL_OVERRIDES)[number];

export class UpdateAutomationSettingDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsIn([...CHANNEL_OVERRIDES])
  channelOverride?: ChannelOverride | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(365)
  cooldownDays?: number | null;

  @IsOptional()
  @Matches(HH_MM_24H, { message: 'quietHoursStart must be HH:mm (24h)' })
  quietHoursStart?: string | null;

  @IsOptional()
  @Matches(HH_MM_24H, { message: 'quietHoursEnd must be HH:mm (24h)' })
  quietHoursEnd?: string | null;
}
