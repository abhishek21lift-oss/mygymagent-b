import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import * as QRCode from 'qrcode';
import { PrismaService } from '../prisma/prisma.service';
import { QueueConnection } from '../queue/queue.module';
import { queuePrefix } from '../queue/queue-prefix';
import { WhatsappInboundFiler } from '../whatsapp/whatsapp-inbound.filer';
import { WhatsappWebAuthStore } from './whatsapp-web.auth-store';
import {
  NotOnWhatsappError,
  WA_ACK,
  WA_DISCONNECT,
  WA_SOCKET_FACTORY,
  WhatsappWebNotReadyError,
  type WaConnectionUpdate,
  type WaMessage,
  type WaMessageKey,
  type WaMessageUpdate,
  type WaSocket,
  type WaSocketFactory,
} from './whatsapp-web.types';

interface Entry {
  socket: WaSocket;
  open: boolean;
  /** Set while this server is tearing the socket down on purpose, so the
   * resulting `close` is not mistaken for a drop to reconnect from. */
  stopping: boolean;
  pairingPhone?: string;
  pairingRequested: boolean;
}

const LOCK_TTL_MS = 60_000;
const LOCK_RENEW_MS = 20_000;
const QR_TTL_S = 60;
const PAIRING_CODE_TTL_S = 180;
const MAX_RECONNECT_DELAY_MS = 60_000;

/**
 * Owns the live WhatsApp Web connections: one socket per gym that has
 * linked its number, kept open for as long as the gym stays linked.
 *
 * **One server per number.** WhatsApp allows one connection per linked
 * device, and a second socket for the same session makes the two knock
 * each other off. So a socket is opened only by the server instance that
 * holds a Redis lock for that gym; the lock is renewed while the socket
 * lives and expires within a minute if the server dies, so another
 * instance can take over. Sends are queued and retried until they reach
 * the instance that holds the socket.
 *
 * **State lives in the database**, not here: `WhatsappWebSession.status`
 * is what the settings page shows and what the renew timer converges on.
 * A server that finds a gym it holds marked DISCONNECTED closes its
 * socket, which is how staff unlinking the number on one instance stops a
 * socket on another. The QR and pairing codes are short-lived and go in
 * Redis, so whichever instance answers the settings page can read them.
 *
 * Off unless WHATSAPP_WEB_ENABLED=true: an unofficial client is something
 * a deployment should opt into, not find running.
 */
@Injectable()
export class WhatsappWebManager
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(WhatsappWebManager.name);
  private readonly entries = new Map<string, Entry>();
  private readonly reconnectAttempts = new Map<string, number>();
  private readonly reconnectTimers = new Map<string, NodeJS.Timeout>();
  private readonly instanceId = randomUUID();
  private readonly prefix: string;
  private renewTimer?: NodeJS.Timeout;
  private shuttingDown = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly queue: QueueConnection,
    private readonly inbound: WhatsappInboundFiler,
    @Inject(WA_SOCKET_FACTORY) private readonly factory: WaSocketFactory,
  ) {
    this.prefix = `wa-web:${queuePrefix({
      QUEUE_PREFIX: config.get<string>('QUEUE_PREFIX'),
      DATABASE_URL: config.get<string>('DATABASE_URL'),
    })}`;
  }

  get enabled(): boolean {
    return this.config.get<string>('WHATSAPP_WEB_ENABLED') === 'true';
  }

  private get redis() {
    return this.queue.client;
  }

  async onApplicationBootstrap(): Promise<void> {
    if (!this.enabled) return;
    this.renewTimer = setInterval(() => void this.renewAll(), LOCK_RENEW_MS);
    this.renewTimer.unref();
    // Resume every gym that was linked when the last server stopped. Not
    // awaited: a slow WhatsApp handshake must not hold up the API booting.
    const linked = await this.prisma.whatsappWebSession.findMany({
      where: { status: 'CONNECTED' },
      select: { organizationId: true },
    });
    for (const { organizationId } of linked) {
      void this.connect(organizationId).catch((error: unknown) =>
        this.logger.warn(
          `Could not resume WhatsApp Web for ${organizationId}: ${describe(error)}`,
        ),
      );
    }
  }

  async onApplicationShutdown(): Promise<void> {
    this.shuttingDown = true;
    if (this.renewTimer) clearInterval(this.renewTimer);
    for (const timer of this.reconnectTimers.values()) clearTimeout(timer);
    for (const [organizationId, entry] of this.entries) {
      entry.stopping = true;
      // end(), never logout(): a deploy must not unlink the gym's phone.
      try {
        entry.socket.end(undefined);
      } catch {
        // already closed
      }
      await this.releaseLock(organizationId).catch(() => undefined);
    }
    this.entries.clear();
  }

  /** Whether this server has an open socket for the gym. */
  isOpen(organizationId: string): boolean {
    return this.entries.get(organizationId)?.open ?? false;
  }

  /**
   * Opens (or resumes) the gym's socket on this server. With
   * `pairingPhone`, asks WhatsApp for an 8-character pairing code for that
   * number instead of relying on the QR -- the only way to link when the
   * settings page is open on the same phone that has to scan.
   */
  async connect(
    organizationId: string,
    options: { pairingPhone?: string } = {},
  ): Promise<void> {
    const existing = this.entries.get(organizationId);
    if (existing) {
      if (options.pairingPhone && !existing.open) {
        existing.pairingPhone = options.pairingPhone;
        existing.pairingRequested = false;
      }
      return;
    }
    if (!(await this.acquireLock(organizationId))) {
      throw new ConflictException(
        'WhatsApp Web for this gym is already running on another server. Try again in a minute.',
      );
    }
    const socket = await this.factory.create(organizationId);
    const entry: Entry = {
      socket,
      open: false,
      stopping: false,
      pairingPhone: options.pairingPhone,
      pairingRequested: false,
    };
    this.entries.set(organizationId, entry);
    socket.ev.on(
      'connection.update',
      (update) =>
        void this.onConnectionUpdate(organizationId, entry, update).catch(
          (error: unknown) =>
            this.logger.error(
              `WhatsApp Web connection handling failed for ${organizationId}: ${describe(error)}`,
            ),
        ),
    );
    socket.ev.on('messages.upsert', ({ messages, type }) => {
      if (type !== 'notify') return;
      void this.onMessages(organizationId, messages).catch((error: unknown) =>
        this.logger.warn(`Inbound filing failed: ${describe(error)}`),
      );
    });
    socket.ev.on(
      'messages.update',
      (updates) =>
        void this.onReceipts(organizationId, updates).catch((error: unknown) =>
          this.logger.warn(`Receipt handling failed: ${describe(error)}`),
        ),
    );
  }

  /**
   * Unlinks the gym's number: logs the device out of WhatsApp (it
   * disappears from the phone's Linked devices), and forgets the keys.
   */
  async disconnect(organizationId: string): Promise<void> {
    this.cancelReconnect(organizationId);
    const entry = this.entries.get(organizationId);
    if (entry) {
      entry.stopping = true;
      try {
        await entry.socket.logout();
      } catch {
        // Not linked yet, or already gone: nothing to log out of.
      }
      try {
        entry.socket.end(undefined);
      } catch {
        // already closed
      }
      this.entries.delete(organizationId);
      await this.releaseLock(organizationId);
    }
    await this.clearCodes(organizationId);
    await WhatsappWebAuthStore.clear(this.prisma, organizationId);
  }

  /** Sends one text. Returns WhatsApp's message id. */
  async send(
    organizationId: string,
    to: string,
    text: string,
  ): Promise<string> {
    const entry = this.entries.get(organizationId);
    if (!entry?.open) throw new WhatsappWebNotReadyError();
    const [result] =
      (await entry.socket.onWhatsApp(`${to}@s.whatsapp.net`)) ?? [];
    if (!result?.exists) throw new NotOnWhatsappError();
    const sent = await entry.socket.sendMessage(result.jid, { text });
    const id = sent?.key?.id;
    if (!id) throw new Error('WhatsApp did not acknowledge the message');
    return id;
  }

  /** The current QR (as an image) and pairing code, while pairing. */
  async codes(
    organizationId: string,
  ): Promise<{ qrDataUrl: string | null; pairingCode: string | null }> {
    const [qr, pairingCode] = await this.redis.mget(
      this.key(organizationId, 'qr'),
      this.key(organizationId, 'code'),
    );
    return {
      qrDataUrl: qr
        ? await QRCode.toDataURL(qr, { margin: 1, width: 320 })
        : null,
      pairingCode,
    };
  }

  // -- events --------------------------------------------------------------

  private async onConnectionUpdate(
    organizationId: string,
    entry: Entry,
    update: WaConnectionUpdate,
  ): Promise<void> {
    if (update.qr) {
      await this.redis.set(
        this.key(organizationId, 'qr'),
        update.qr,
        'EX',
        QR_TTL_S,
      );
      if (entry.pairingPhone && !entry.pairingRequested) {
        entry.pairingRequested = true;
        const code = await entry.socket.requestPairingCode(entry.pairingPhone);
        await this.redis.set(
          this.key(organizationId, 'code'),
          code,
          'EX',
          PAIRING_CODE_TTL_S,
        );
      }
    }

    if (update.connection === 'open') {
      entry.open = true;
      this.reconnectAttempts.delete(organizationId);
      await this.clearCodes(organizationId);
      await this.prisma.whatsappWebSession.update({
        where: { organizationId },
        data: {
          status: 'CONNECTED',
          phoneNumber: jidDigits(entry.socket.user?.id),
          connectedAt: new Date(),
          lastError: null,
        },
      });
      return;
    }

    if (update.connection !== 'close') return;
    entry.open = false;
    if (entry.stopping || this.shuttingDown) return;
    this.entries.delete(organizationId);
    const code = statusCode(update.lastDisconnect?.error);

    if (code === WA_DISCONNECT.LOGGED_OUT || code === WA_DISCONNECT.FORBIDDEN) {
      // Unlinked from the phone, or WhatsApp refused the number. The keys
      // are dead either way; a new link starts from a new QR.
      await WhatsappWebAuthStore.clear(this.prisma, organizationId);
      await this.clearCodes(organizationId);
      await this.releaseLock(organizationId);
      await this.prisma.whatsappWebSession.update({
        where: { organizationId },
        data: {
          status: 'LOGGED_OUT',
          useForSending: false,
          disconnectedAt: new Date(),
          lastError:
            code === WA_DISCONNECT.FORBIDDEN
              ? 'WhatsApp blocked or restricted this number.'
              : 'The number was unlinked from the phone. Link it again to keep sending.',
        },
      });
      return;
    }

    const session = await this.prisma.whatsappWebSession.findUnique({
      where: { organizationId },
      select: { status: true },
    });
    if (session?.status === 'PAIRING' && code === WA_DISCONNECT.TIMED_OUT) {
      // Nobody scanned in time. Stop, rather than generating QR codes
      // for an empty room forever.
      await WhatsappWebAuthStore.clear(this.prisma, organizationId);
      await this.clearCodes(organizationId);
      await this.releaseLock(organizationId);
      await this.prisma.whatsappWebSession.update({
        where: { organizationId },
        data: {
          status: 'DISCONNECTED',
          lastError: 'The code expired before it was scanned. Start again.',
        },
      });
      return;
    }
    if (session?.status !== 'CONNECTED' && session?.status !== 'PAIRING') {
      await this.releaseLock(organizationId);
      return;
    }
    // A dropped connection, or WhatsApp asking for a restart after
    // pairing: reconnect with the same keys, backing off if it keeps
    // failing. The lock is kept, so no other server takes over meanwhile.
    this.scheduleReconnect(
      organizationId,
      code === WA_DISCONNECT.RESTART_REQUIRED,
    );
  }

  private async onMessages(organizationId: string, messages: WaMessage[]) {
    for (const message of messages) {
      if (message.key.fromMe) continue;
      const text =
        message.message?.conversation ??
        message.message?.extendedTextMessage?.text;
      const from = phoneJid(message.key);
      // Group chats, broadcasts and senders WhatsApp only identifies by
      // LID have no phone number to match to a member.
      if (!text || !from) continue;
      await this.inbound.file(organizationId, jidDigits(from)!, text);
    }
  }

  private async onReceipts(organizationId: string, updates: WaMessageUpdate[]) {
    for (const { key, update } of updates) {
      if (!key.fromMe || !key.id || update.status == null) continue;
      const status =
        update.status >= WA_ACK.READ
          ? 'READ'
          : update.status >= WA_ACK.DELIVERED
            ? 'DELIVERED'
            : null;
      if (!status) continue;
      // Forward only: a late "delivered" must not undo "read".
      await this.prisma.messageLog.updateMany({
        where: {
          organizationId,
          providerMessageId: `waweb:${key.id}`,
          status: { in: status === 'READ' ? ['SENT', 'DELIVERED'] : ['SENT'] },
        },
        data: { status },
      });
    }
  }

  // -- reconnects and the lock ---------------------------------------------

  private scheduleReconnect(organizationId: string, immediately: boolean) {
    const attempt = (this.reconnectAttempts.get(organizationId) ?? 0) + 1;
    this.reconnectAttempts.set(organizationId, attempt);
    const delay = immediately
      ? 0
      : Math.min(MAX_RECONNECT_DELAY_MS, 1_000 * 2 ** (attempt - 1));
    this.cancelReconnect(organizationId);
    const timer = setTimeout(() => {
      this.reconnectTimers.delete(organizationId);
      void this.releaseLock(organizationId)
        .then(() => this.connect(organizationId))
        .catch((error: unknown) => {
          this.logger.warn(
            `WhatsApp Web reconnect failed for ${organizationId}: ${describe(error)}`,
          );
          this.scheduleReconnect(organizationId, false);
        });
    }, delay);
    timer.unref();
    this.reconnectTimers.set(organizationId, timer);
  }

  private cancelReconnect(organizationId: string) {
    const timer = this.reconnectTimers.get(organizationId);
    if (timer) clearTimeout(timer);
    this.reconnectTimers.delete(organizationId);
  }

  /** Renews this server's locks, and closes sockets for gyms that were
   * unlinked elsewhere. */
  private async renewAll() {
    for (const [organizationId, entry] of this.entries) {
      const session = await this.prisma.whatsappWebSession
        .findUnique({ where: { organizationId }, select: { status: true } })
        .catch(() => null);
      if (
        session &&
        session.status !== 'CONNECTED' &&
        session.status !== 'PAIRING'
      ) {
        entry.stopping = true;
        try {
          await entry.socket.logout();
        } catch {
          // nothing to log out of
        }
        entry.socket.end(undefined);
        this.entries.delete(organizationId);
        await this.releaseLock(organizationId).catch(() => undefined);
        continue;
      }
      await this.redis
        .eval(
          "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end",
          1,
          this.key(organizationId, 'lock'),
          this.instanceId,
          String(LOCK_TTL_MS),
        )
        .catch(() => undefined);
    }
  }

  private async acquireLock(organizationId: string): Promise<boolean> {
    const lockKey = this.key(organizationId, 'lock');
    const ok = await this.redis.set(
      lockKey,
      this.instanceId,
      'PX',
      LOCK_TTL_MS,
      'NX',
    );
    if (ok === 'OK') return true;
    return (await this.redis.get(lockKey)) === this.instanceId;
  }

  private async releaseLock(organizationId: string): Promise<void> {
    await this.redis.eval(
      "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
      1,
      this.key(organizationId, 'lock'),
      this.instanceId,
    );
  }

  private async clearCodes(organizationId: string) {
    await this.redis.del(
      this.key(organizationId, 'qr'),
      this.key(organizationId, 'code'),
    );
  }

  key(organizationId: string, name: string): string {
    return `${this.prefix}:${organizationId}:${name}`;
  }
}

/** Baileys reports disconnects as Boom errors carrying an HTTP-style code. */
function statusCode(error: unknown): number | undefined {
  const output = (error as { output?: { statusCode?: number } } | undefined)
    ?.output;
  return output?.statusCode;
}

/** The chat's phone-number JID, whichever field Baileys put it in. */
function phoneJid(key: WaMessageKey): string | null {
  for (const jid of [key.remoteJid, key.remoteJidAlt, key.senderPn]) {
    if (jid?.endsWith('@s.whatsapp.net')) return jid;
  }
  return null;
}

/** `919812345678:12@s.whatsapp.net` -> `919812345678`. */
function jidDigits(jid: string | null | undefined): string | null {
  if (!jid) return null;
  const digits = jid.split('@')[0].split(':')[0].replace(/\D/g, '');
  return digits || null;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
