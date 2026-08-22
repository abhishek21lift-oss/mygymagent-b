import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { AiConversationsService } from '../src/ai/conversations/ai-conversations.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp, type RegisteredAccount } from './utils/test-app';

/**
 * AI memory (P3): conversations persist across requests. `.env.test` has
 * no OPENROUTER_API_KEY (see ai.e2e-spec.ts's own comment), so a chat()
 * call always fails at the provider with a 503 before producing a reply
 * -- but conversation creation and the user's message are persisted
 * *before* that provider call happens, which is exactly what these
 * tests can verify without a live model. The rest of the transcript
 * (an assistant turn, tool-call metadata) is exercised by calling
 * AiConversationsService directly, the same way ai.e2e-spec.ts calls
 * ToolExecutorService directly to test what a live model call would
 * otherwise drive.
 */
describe('AI conversations / memory (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let conversations: AiConversationsService;
  let orgA: RegisteredAccount;
  let orgB: RegisteredAccount;

  async function registerOrg(name: string): Promise<RegisteredAccount> {
    const email = `${name.toLowerCase().replace(/\s+/g, '-')}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 8)}@example.com`;
    const res = await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        organizationName: name,
        email,
        password: 'CorrectHorseBattery9',
        firstName: 'Owner',
        lastName: name,
      })
      .expect(201);

    const branches = await request(app.getHttpServer())
      .get('/branches')
      .set('Authorization', `Bearer ${res.body.data.accessToken}`)
      .expect(200);

    return {
      accessToken: res.body.data.accessToken,
      organizationId: res.body.data.organization.id,
      userId: res.body.data.user.id,
      branchId: branches.body.data.items[0].id,
    };
  }

  const authed = (token: string) => (req: request.Test) =>
    req.set('Authorization', `Bearer ${token}`);

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    conversations = app.get(AiConversationsService);
    orgA = await registerOrg('Conversations Test Gym A');
    orgB = await registerOrg('Conversations Test Gym B');
  });

  afterAll(async () => {
    await app.close();
  });

  it("persists the user's message and creates a conversation even though the provider call fails", async () => {
    await authed(orgA.accessToken)(
      request(app.getHttpServer())
        .post('/ai/chat')
        .send({ message: 'hello there' }),
    ).expect(503);

    const conversation = await prisma.aiConversation.findFirst({
      where: { organizationId: orgA.organizationId, userId: orgA.userId },
      orderBy: { createdAt: 'desc' },
      include: { messages: true },
    });
    expect(conversation).not.toBeNull();
    expect(conversation!.messages).toHaveLength(1);
    expect(conversation!.messages[0].role).toBe('USER');
    expect(conversation!.messages[0].content).toBe('hello there');
  });

  it('reuses the same conversation when a conversationId is passed back, appending to it', async () => {
    await authed(orgA.accessToken)(
      request(app.getHttpServer())
        .post('/ai/chat')
        .send({ message: 'first turn' }),
    ).expect(503);

    const conversation = await prisma.aiConversation.findFirst({
      where: { organizationId: orgA.organizationId, userId: orgA.userId },
      orderBy: { createdAt: 'desc' },
    });
    const conversationId = conversation!.id;

    await authed(orgA.accessToken)(
      request(app.getHttpServer())
        .post('/ai/chat')
        .send({ message: 'second turn', conversationId }),
    ).expect(503);

    const messages = await prisma.aiMessage.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'asc' },
    });
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toBe('first turn');
    expect(messages[1].content).toBe('second turn');
  });

  it('rejects a conversationId that does not exist, before ever calling the provider', async () => {
    await authed(orgA.accessToken)(
      request(app.getHttpServer())
        .post('/ai/chat')
        .send({ message: 'hi', conversationId: 'does-not-exist' }),
    ).expect(404);
  });

  it("rejects using another org's (or another user's) conversationId", async () => {
    await authed(orgA.accessToken)(
      request(app.getHttpServer())
        .post('/ai/chat')
        .send({ message: 'seed a real conversation' }),
    ).expect(503);
    const conversation = await prisma.aiConversation.findFirst({
      where: { organizationId: orgA.organizationId, userId: orgA.userId },
      orderBy: { createdAt: 'desc' },
    });

    await authed(orgB.accessToken)(
      request(app.getHttpServer())
        .post('/ai/chat')
        .send({ message: 'hi', conversationId: conversation!.id }),
    ).expect(404);
  });

  it('lists conversations with a preview and message count, and returns the full transcript on demand', async () => {
    const created = await conversations.getOrCreate(
      orgA.organizationId,
      orgA.userId,
    );
    await conversations.appendMessage(
      created.id,
      'USER',
      'What is my revenue this month?',
    );
    await conversations.appendMessage(
      created.id,
      'ASSISTANT',
      'Here is your revenue summary.',
      [{ name: 'get_revenue_summary', args: {} }],
    );

    const list = await authed(orgA.accessToken)(
      request(app.getHttpServer()).get('/ai/conversations'),
    ).expect(200);
    const listed = list.body.data.items.find(
      (c: { id: string }) => c.id === created.id,
    );
    expect(listed).toBeDefined();
    expect(listed.messageCount).toBe(2);
    expect(listed.preview).toBe('What is my revenue this month?');

    const detail = await authed(orgA.accessToken)(
      request(app.getHttpServer()).get(`/ai/conversations/${created.id}`),
    ).expect(200);
    expect(detail.body.data.messages).toHaveLength(2);
    expect(detail.body.data.messages[1].role).toBe('ASSISTANT');
    expect(detail.body.data.messages[1].toolCalls).toEqual([
      { name: 'get_revenue_summary', args: {} },
    ]);
  });

  it("does not list or expose another user's conversation, even within the same org", async () => {
    const otherUserEmail = `other-conv-user-${Date.now()}@example.com`;
    const invited = await authed(orgA.accessToken)(
      request(app.getHttpServer()).post('/users').send({
        email: otherUserEmail,
        firstName: 'Other',
        lastName: 'User',
        primaryBranchId: orgA.branchId,
        roleKey: 'ORG_ADMIN',
      }),
    ).expect(201);
    const otherUserId = invited.body.data.id;

    const created = await conversations.getOrCreate(
      orgA.organizationId,
      orgA.userId,
    );

    await expect(
      conversations.getOne(orgA.organizationId, otherUserId, created.id),
    ).rejects.toThrow('Conversation not found');
  });

  it('soft-deletes on request: hidden from the owner, but the row and its messages survive for audit', async () => {
    const created = await conversations.getOrCreate(
      orgA.organizationId,
      orgA.userId,
    );
    await conversations.appendMessage(created.id, 'USER', 'delete me later');

    await authed(orgA.accessToken)(
      request(app.getHttpServer()).delete(`/ai/conversations/${created.id}`),
    ).expect(204);

    await authed(orgA.accessToken)(
      request(app.getHttpServer()).get(`/ai/conversations/${created.id}`),
    ).expect(404);

    const stillThere = await prisma.aiConversation.findUnique({
      where: { id: created.id },
      include: { messages: true },
    });
    expect(stillThere).not.toBeNull();
    expect(stillThere!.deletedAt).not.toBeNull();
    expect(stillThere!.messages).toHaveLength(1);
  });
});
