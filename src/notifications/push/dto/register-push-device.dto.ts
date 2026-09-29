import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class RegisterPushDeviceDto {
  /** The FCM registration token the client SDK issued for this install.
   * Real tokens are ~160-200 chars; 4096 bounds abuse, not validity. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  token!: string;
}
