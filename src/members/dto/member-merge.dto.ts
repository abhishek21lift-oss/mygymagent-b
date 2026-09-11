import { IsObject, IsString } from 'class-validator';

export class ExecuteMergeDto {
  @IsString()
  sourceMemberId!: string;

  @IsString()
  targetMemberId!: string;

  /// Field -> 'source' | 'target' winner picks. Keys and values are
  /// validated in the service (unknown fields rejected, missing fields
  /// default to 'target'); the DTO only guarantees an object shape.
  @IsObject()
  resolution!: Record<string, 'source' | 'target'>;
}
