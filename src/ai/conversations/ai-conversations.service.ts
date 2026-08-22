import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { paginate, skipTake } from '../../common/dto/pagination-query.dto';
import { PrismaService } from '../../prisma/prisma.service';
import type { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import type { ChatMessage } from '../providers/openrouter.provider';

/**
 * AI memory (P3): persists every chat() exchange so a conversation
 * survives across requests/sessions -- see the `AiConversation`/
 * `AiMessage` schema comment and docs/database/data-retention.md's
 * AI-conversations section (tenant-scoped, soft-delete only, never used
 * as training data).
 */
@Injectable()
export class AiConversationsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Creates a new conversation, or loads and confirms ownership of an
   * existing one -- the single entry point `AiService.chat()` uses at
   * the start of every call, so a conversationId that doesn't belong to
   * this org+user (or was soft-deleted) fails the same way a not-found
   * one does, not with a silent fallback to someone else's history. */
  async getOrCreate(
    organizationId: string,
    userId: string,
    conversationId?: string,
  ) {
    if (!conversationId) {
      return this.prisma.aiConversation.create({
        data: { organizationId, userId },
      });
    }
    const conversation = await this.prisma.aiConversation.findFirst({
      where: { id: conversationId, organizationId, userId, deletedAt: null },
    });
    if (!conversation) {
      throw new NotFoundException('Conversation not found');
    }
    return conversation;
  }

  /** Persisted history as `ChatMessage`s, ready to feed straight into
   * `OpenRouterProvider.chatCompletion()` -- only USER/ASSISTANT turns,
   * never the underlying tool-call mechanics (see the AiMessage schema
   * comment for why). */
  async getHistory(conversationId: string): Promise<ChatMessage[]> {
    const messages = await this.prisma.aiMessage.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'asc' },
      select: { role: true, content: true },
    });
    return messages.map((m) => ({
      role: m.role === 'USER' ? 'user' : 'assistant',
      content: m.content,
    }));
  }

  async appendMessage(
    conversationId: string,
    role: 'USER' | 'ASSISTANT',
    content: string,
    toolCalls?: { name: string; args: unknown }[],
  ) {
    await this.prisma.$transaction([
      this.prisma.aiMessage.create({
        data: {
          conversationId,
          role,
          content,
          toolCalls:
            toolCalls && toolCalls.length > 0
              ? (toolCalls as unknown as Prisma.InputJsonValue)
              : undefined,
        },
      }),
      // `updatedAt` drives "most recently active" ordering in list() --
      // touch it on every append, not just at creation.
      this.prisma.aiConversation.update({
        where: { id: conversationId },
        data: { updatedAt: new Date() },
      }),
    ]);
  }

  async list(
    organizationId: string,
    userId: string,
    query: PaginationQueryDto,
  ) {
    const where = { organizationId, userId, deletedAt: null };
    const [items, total] = await Promise.all([
      this.prisma.aiConversation.findMany({
        where,
        ...skipTake(query),
        orderBy: { updatedAt: 'desc' },
        include: {
          messages: { orderBy: { createdAt: 'asc' as const }, take: 1 },
          _count: { select: { messages: true } },
        },
      }),
      this.prisma.aiConversation.count({ where }),
    ]);
    return paginate(
      items.map((c) => ({
        id: c.id,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
        messageCount: c._count.messages,
        preview: c.messages[0]?.content ?? null,
      })),
      total,
      query.page,
      query.pageSize,
    );
  }

  async getOne(organizationId: string, userId: string, id: string) {
    const conversation = await this.prisma.aiConversation.findFirst({
      where: { id, organizationId, userId, deletedAt: null },
      include: { messages: { orderBy: { createdAt: 'asc' } } },
    });
    if (!conversation) throw new NotFoundException('Conversation not found');
    return conversation;
  }

  /** Soft-delete only -- see the schema comment and data-retention.md:
   * hides it from this user, never physically removes the org's record
   * of what the AI was asked/told. */
  async softDelete(organizationId: string, userId: string, id: string) {
    await this.getOne(organizationId, userId, id);
    await this.prisma.aiConversation.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }
}
