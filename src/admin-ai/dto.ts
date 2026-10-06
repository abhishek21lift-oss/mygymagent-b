import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

export class CreateKeyDto {
  @IsString()
  @MaxLength(60)
  platform!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  key?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  label?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  proxyUrl?: string;
}

export class PatchKeyDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  label?: string;

  @IsOptional()
  @IsArray()
  modelScope?: string[] | null;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  proxyUrl?: string;
}

export class PatchModelDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  displayName?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsBoolean()
  fallbackEnabled?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  rpmLimit?: number | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  rpdLimit?: number | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  tpmLimit?: number | null;

  @IsOptional()
  @IsInt()
  @Min(0)
  tpdLimit?: number | null;

  @IsOptional()
  @IsBoolean()
  supportsTools?: boolean;

  @IsOptional()
  @IsBoolean()
  supportsVision?: boolean;
}

export class FallbackRowDto {
  @IsInt()
  @Min(0)
  modelDbId!: number;

  @IsInt()
  @Min(0)
  priority!: number;

  @IsBoolean()
  enabled!: boolean;
}

export class UpdateFallbackDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => FallbackRowDto)
  rows!: FallbackRowDto[];
}

const ROUTING_STRATEGIES = [
  'priority',
  'balanced',
  'smartest',
  'fastest',
  'reliable',
  'custom',
] as const;

export class UpdateRoutingDto {
  @IsIn([...ROUTING_STRATEGIES])
  strategy!: (typeof ROUTING_STRATEGIES)[number];

  @IsOptional()
  @IsObject()
  weights?: Record<string, number>;

  @IsOptional()
  @IsBoolean()
  exploreEnabled?: boolean;

  @IsOptional()
  @IsIn(['auto', 'least-remaining'])
  keySelectionStrategy?: string;
}

/** Allowlisted settings sections only -- secrets (api-key, proxy token,
 * url-tokens mint) are never writable through this API. */
export const WRITABLE_SETTINGS_SECTIONS = [
  'compression',
  'fusion',
  'anthropic-map',
  'gemini-map',
  'agent-compatibility',
  'guardrails',
  'headroom',
  'output-limit',
  'unify',
  'update-check',
] as const;

export type WritableSettingsSection =
  (typeof WRITABLE_SETTINGS_SECTIONS)[number];

export class UpdateSettingsDto {
  @IsObject()
  value!: Record<string, unknown>;
}

export class CreateBackupDto {
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tables?: string[];
}

export class CreateClientProfileDto {
  @IsString()
  @Matches(/^[A-Za-z0-9 _-]{1,100}$/)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(32000)
  systemPrompt?: string | null;
}

export class PatchClientProfileDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(32000)
  systemPrompt?: string | null;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class AnalyticsRangeDto {
  @IsOptional()
  @IsIn(['24h', '7d', '30d', '90d'])
  range?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset?: number;

  @IsOptional()
  @IsIn(['success', 'error', 'canceled'])
  status?: string;

  @IsOptional()
  @IsIn(['hour', 'day'])
  interval?: string;
}

export class LogsQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  levels?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  sinceId?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  q?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  provider?: string;
}

/** Destructive operations require ?confirm=true in addition to platform role. */
export function requireConfirm(confirm: unknown): void {
  if (confirm !== true && confirm !== 'true') {
    // Throwing BadRequest-equivalent without importing Http here is handled
    // by the controller via BadRequestException; this helper centralizes the check.
    throw new Error('CONFIRM_REQUIRED');
  }
}
