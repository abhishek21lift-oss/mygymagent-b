import { IsString } from 'class-validator';

/** Shared arg shape for read_member/read_workout_history/read_attendance --
 * they all take just a memberId. */
export class MemberIdArgsDto {
  @IsString()
  memberId!: string;
}
