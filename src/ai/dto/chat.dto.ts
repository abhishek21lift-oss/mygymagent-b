import { Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';

export class ChatHistoryMessageDto {
  @IsIn(['user', 'assistant'])
  role!: 'user' | 'assistant';

  @IsString()
  content!: string;
}

/** `conversationId` opts into AI memory (P3, src/ai/conversations/):
 * omit it and a new conversation is created automatically, whose id
 * comes back in the response for the client to continue next time; pass
 * a previous response's `conversationId` back to continue that thread,
 * loading its real persisted history instead of `history` below.
 * `history` still works standalone (client-managed, no persistence tie-in)
 * for a caller that never adopts conversationId -- it's only used when
 * `conversationId` is omitted, since a tracked conversation's own
 * persisted history is authoritative once one exists. */
export class ChatDto {
  @IsString()
  message!: string;

  @IsOptional()
  @IsString()
  conversationId?: string;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ChatHistoryMessageDto)
  history?: ChatHistoryMessageDto[];
}
