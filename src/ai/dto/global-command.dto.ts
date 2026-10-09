import {
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/** The body of POST /global-ai/command. A class, not an interface, so the
 * global ValidationPipe can check it: an interface gave it nothing to
 * check, and any size of string went into the prompt and the command log.
 * The organization and user always come from the session, never from here. */
export class GlobalCommandDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  command!: string;

  @IsOptional()
  @IsObject()
  context?: Record<string, unknown>;
}
