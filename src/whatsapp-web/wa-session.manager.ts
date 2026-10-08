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
import { sessionIdFor } from './wa-types';
import { PrismaService } from '../prisma/prisma.service';
import { QueueConnection } from '../queue/queue.module';
import { queuePrefix } from '../queue/queue-prefix';
import { WhatsappInboundFiler } from '../whatsapp/whatsapp-inbound.filer';
import {
  jidDigits,
  messageText,
  NotLinkedError,
  NotOnWhatsappError,
  phoneJid,
  WA_ACK,
  WA_DISCONNECT,
  WA_SOCKET_FACTORY,
  type WaConnectionUpdate,
  type WaMessage,
  type WaMessageUpdate,
  type WaSendContent,
  type WaSocket,
  type WaSocketFactory,
} from './wa-types';

interface Entry {
  socket: WaSocket;
  /** The `WaSession.id` this socket's keys live under. */
  waSessionId: string;
  open: boolean;
  /** Set while this server is tearing the socket down on purpose, so the
   * resulting `close` is not mistaken for a drop to reconnect from. */
  stopping: boolean;
  pairingPhone?: string;
  pairingRequested: boolean;
  /** WhatsApp has answered at least once (a QR or an open session). */
  responded: boolean;
}

const LOCK_TTL_MS = 60_000;
const LOCK_RENEW_MS = 20_000;
const QR_TTL_S = 60;
const PAIRING_CODE_TTL_S = 180;
const MAX_RECONNECT_DELAY_MS = 60_000;
/** Failed attempts while linking before we stop and say why. */
const MAX_PAIRING_FAILURES = 3;
/** How long to wait for WhatsApp's first answer (a QR) when linking. */
const PAIRING_TIMEOUT_MS = 45_000;

/**
 * Owns the live WhatsApp connections: one socket per gym that has
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
 * **Liveness lives in `WaSession`**, preferences in `WhatsappWebSession`:
 * the settings page reads both. The QR and pairing codes are short-lived
 * and go in Redis, so whichever instance answers the settings page can
 * read them. Inbound messages and receipts arrive in Phase 2.
 */
@Injectable()
export class WaSessionManager
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(WaSessionManager.name);
  private readonly entries = new Map<string, Entry>();
  private readonly reconnectAttempts = new Map<string, number>();
  private readonly reconnectTimers = new Map<string, NodeJS.Timeout>();
  private readonly watchdogs = new Map<string, NodeJS.Timeout>();
  private readonly pairingFailures = new Map<string, number>();
  private readonly instanceId = randomUUID();
  private readonly prefix: string;
  private renewTimer?: NodeJS.Timeout;
  private shuttingDown = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly queue: QueueConnection,
    @Inject(WA_SOCKET_FACTORY) private readonly factory: WaSocketFactory,
    private readonly inbound: WhatsappInboundFiler,
  ) {
    this.prefix = `wa-session:${queuePrefix({
      QUEUE_PREFIX: config.get<string>('QUEUE_PREFIX'),
      DATABASE_URL: config.get<string>('DATABASE_URL'),
    })}`;
  }

  private get redis() {
    return this.queue.client;
  }

  async onApplicationBootstrap(): Promise<void> {
    this.renewTimer = setInterval(() => void this.renewAll(), LOCK_RENEW_MS);
    this.renewTimer.unref();
    await this.resumeLinked();
  }

  /**
   * Resumes every gym that was mid-pairing or connected when the last
   * server stopped. Not awaited per gym: a slow WhatsApp handshake must
   * not hold up the API booting. A gym whose lock is still held is
   * retried with backoff until it is free.
   */
  async resumeLinked(): Promise<void> {
    const linked = await this.prisma.waSession.findMany({
      where: { status: { in: ['PAIRING', 'CONNECTED'] } },
      select: { organizationId: true },
    });
    for (const { organizationId } of linked) {
      void this.connect(organizationId).catch((error: unknown) => {
        this.logger.warn(
          `Could not resume WhatsApp for ${organizationId}: ${describe(error)}`,
        );
        if (error instanceof ConflictException && !this.shuttingDown) {
          this.scheduleReconnect(organizationId, false);
        }
      });
    }
  }

  async onApplicationShutdown(): Promise<void> {
    this.shuttingDown = true;
    if (this.renewTimer) clearInterval(this.renewTimer);
    for (const timer of this.reconnectTimers.values()) clearTimeout(timer);
    for (const timer of this.watchdogs.values()) clearTimeout(timer);
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
        'WhatsApp for this gym is already running on another server. Try again in a minute.',
      );
    }
    const session = await this.prisma.waSession.upsert({
      where: { organizationId },
      create: {
        organizationId,
        sessionId: sessionIdFor(organizationId),
        status: 'PAIRING',
      },
      update: { status: 'PAIRING', lastError: null },
    });
    let socket: WaSocket;
    try {
      socket = await this.factory.create({
        organizationId,
        waSessionId: session.id,
      });
    } catch (error) {
      // A socket that never opened must not hold the lock: the next
      // attempt would otherwise report "already running on another
      // server" for a full TTL while nothing is.
      await this.releaseLock(organizationId).catch(() => undefined);
      await this.prisma.waSession
        .update({
          where: { organizationId },
          data: {
            status: 'DISCONNECTED',
            lastError: error instanceof Error ? error.message : String(error),
          },
        })
        .catch(() => undefined);
      throw error;
    }
    const entry: Entry = {
      socket,
      waSessionId: session.id,
      open: false,
      stopping: false,
      pairingPhone: options.pairingPhone,
      pairingRequested: false,
      responded: false,
    };
    this.entries.set(organizationId, entry);
    // Listen before awaiting anything: an event WhatsApp sends while this
    // method is still waiting on the database would otherwise be lost,
    // and a lost `close` means the gym never reconnects.
    socket.ev.on(
      'connection.update',
      (update) =>
        void this.onConnectionUpdate(organizationId, entry, update).catch(
          (error: unknown) =>
            this.logger.error(
              `WhatsApp connection handling failed for ${organizationId}: ${describe(error)}`,
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
    await this.armWatchdog(organizationId, entry);
  }

  /**
   * Unlinks the gym's number: logs the device out of WhatsApp (it
   * disappears from the phone's Linked devices), and forgets the keys.
   */
  async disconnect(organizationId: string): Promise<void> {
    this.cancelReconnect(organizationId);
    this.clearWatchdog(organizationId);
    this.forgetRetries(organizationId);
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
    await this.clearKeys(entry?.waSessionId);
    await this.prisma.waSession.updateMany({
      where: { organizationId },
      data: { status: 'DISCONNECTED' },
    });
  }

  /**
   * Sends one message. Returns WhatsApp's message id. `replyToMessageId`
   * rides along for fakes and future stanza quoting -- P1 never quotes on
   * a real socket (no stanza store yet), it sends plain instead.
   */
  async sendNow(
    organizationId: string,
    jid: string,
    content: WaSendContent,
  ): Promise<string> {
    const entry = this.entries.get(organizationId);
    if (!entry?.open) throw new NotLinkedError();
    const [result] = (await entry.socket.onWhatsApp(jid)) ?? [];
    if (!result?.exists) throw new NotOnWhatsappError();
    const sent = await entry.socket.sendMessage(result.jid, content);
    const id = sent?.key?.id;
    if (!id) throw new Error('WhatsApp did not acknowledge the message');
    return id;
  }

  /** Live status: the open socket wins, otherwise the stored row. */
  async getStatus(
    organizationId: string,
  ): Promise<'CONNECTED' | 'PAIRING' | 'DISCONNECTED' | 'LOGGED_OUT'> {
    if (this.entries.get(organizationId)?.open) return 'CONNECTED';
    const session = await this.prisma.waSession.findUnique({
      where: { organizationId },
      select: { status: true },
    });
    return session?.status ?? 'DISCONNECTED';
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
    if (update.connection || update.lastDisconnect) {
      const reason = describeDisconnect(update.lastDisconnect?.error);
      this.logger.log(
        `WhatsApp ${organizationId}: ${update.connection ?? 'update'}${reason ? ` (${reason})` : ''}`,
      );
    }
    if (update.qr || update.connection === 'open') {
      entry.responded = true;
      this.clearWatchdog(organizationId);
    }
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
      this.forgetRetries(organizationId);
      await this.clearCodes(organizationId);
      await this.prisma.waSession.update({
        where: { organizationId },
        data: {
          status: 'CONNECTED',
          phoneNumber: jidDigits(entry.socket.user?.id),
          connectedAt: new Date(),
          lastError: null,
          qr: null,
          pairingCode: null,
        },
      });
      return;
    }

    if (update.connection !== 'close') return;
    entry.open = false;
    this.clearWatchdog(organizationId);
    if (entry.stopping || this.shuttingDown) return;
    this.entries.delete(organizationId);
    const code = statusCode(update.lastDisconnect?.error);

    if (code === WA_DISCONNECT.LOGGED_OUT || code === WA_DISCONNECT.FORBIDDEN) {
      // Unlinked from the phone, or WhatsApp refused the number. The keys
      // are dead either way; a new link starts from a new QR.
      await this.clearKeys(entry.waSessionId);
      await this.clearCodes(organizationId);
      await this.releaseLock(organizationId);
      await this.prisma.waSession.update({
        where: { organizationId },
        data: {
          status: 'LOGGED_OUT',
          lastError:
            code === WA_DISCONNECT.FORBIDDEN
              ? 'WhatsApp blocked or restricted this number.'
              : 'The number was unlinked from the phone. Link it again to keep sending.',
        },
      });
      return;
    }

    const session = await this.prisma.waSession.findUnique({
      where: { organizationId },
      select: { status: true },
    });
    if (session?.status === 'PAIRING' && code === WA_DISCONNECT.TIMED_OUT) {
      // Nobody scanned in time. Stop, rather than generating QR codes
      // for an empty room forever.
      await this.clearKeys(entry.waSessionId);
      await this.clearCodes(organizationId);
      await this.releaseLock(organizationId);
      await this.prisma.waSession.update({
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
    if (
      session.status === 'PAIRING' &&
      code !== WA_DISCONNECT.RESTART_REQUIRED
    ) {
      // Failing while linking: say why on the settings page as it
      // happens, and stop after a few tries instead of spinning forever.
      const failures = (this.pairingFailures.get(organizationId) ?? 0) + 1;
      this.pairingFailures.set(organizationId, failures);
      const reason =
        describeDisconnect(update.lastDisconnect?.error) || 'no reason given';
      if (failures >= MAX_PAIRING_FAILURES) {
        await this.abandonPairing(
          organizationId,
          `Couldn't connect to WhatsApp after ${failures} tries (${reason}).`,
        );
        return;
      }
      await this.prisma.waSession.update({
        where: { organizationId },
        data: {
          lastError: `Connecting to WhatsApp failed (${reason}). Retrying…`,
        },
      });
    }
    // A dropped connection, or WhatsApp asking for a restart after
    // pairing: reconnect with the same keys, backing off if it keeps
    // failing. The lock is kept, so no other server takes over meanwhile.
    this.scheduleReconnect(
      organizationId,
      code === WA_DISCONNECT.RESTART_REQUIRED,
    );
  }

  // -- inbound and receipts ------------------------------------------------

  private async onMessages(organizationId: string, messages: WaMessage[]) {
    for (const message of messages) {
      if (message.key.fromMe) continue;
      const text = messageText(message.message);
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
          providerMessageId: `waakg:${key.id}`,
          status: { in: status === 'READ' ? ['SENT', 'DELIVERED'] : ['SENT'] },
        },
        data: { status },
      });
    }
  }

  // -- linking watchdog ----------------------------------------------------

  /**
   * While linking a number, WhatsApp should answer with a QR within
   * seconds. If it says nothing at all -- the server cannot reach
   * web.whatsapp.com, or the connection is silently dropped -- stop and
   * say so, rather than leave the settings page on a spinner forever.
   * Not armed when resuming a linked number: that has its own reconnects.
   */
  private async armWatchdog(organizationId: string, entry: Entry) {
    const session = await this.prisma.waSession.findUnique({
      where: { organizationId },
      select: { status: true },
    });
    if (session?.status !== 'PAIRING') return;
    if (entry.responded || entry.stopping) return;
    if (this.entries.get(organizationId) !== entry) return;
    this.clearWatchdog(organizationId);
    const timer = setTimeout(() => {
      this.watchdogs.delete(organizationId);
      if (entry.responded || entry.stopping) return;
      if (this.entries.get(organizationId) !== entry) return;
      void this.abandonPairing(
        organizationId,
        `WhatsApp didn't answer the server within ${Math.round(PAIRING_TIMEOUT_MS / 1000)} seconds, so no QR code could be shown. The server may be unable to reach web.whatsapp.com (check its outbound network or firewall). Try again; if it repeats, check the server logs for "WhatsApp".`,
      ).catch((error: unknown) =>
        this.logger.error(`Abandoning pairing failed: ${describe(error)}`),
      );
    }, PAIRING_TIMEOUT_MS);
    timer.unref();
    this.watchdogs.set(organizationId, timer);
  }

  private clearWatchdog(organizationId: string) {
    const timer = this.watchdogs.get(organizationId);
    if (timer) clearTimeout(timer);
    this.watchdogs.delete(organizationId);
  }

  /** Stops a link attempt and records why, for the settings page. */
  private async abandonPairing(organizationId: string, reason: string) {
    this.logger.warn(
      `WhatsApp ${organizationId}: gave up linking -- ${reason}`,
    );
    this.cancelReconnect(organizationId);
    this.forgetRetries(organizationId);
    const entry = this.entries.get(organizationId);
    if (entry) {
      entry.stopping = true;
      try {
        entry.socket.end(undefined);
      } catch {
        // already closed
      }
      this.entries.delete(organizationId);
      await this.clearKeys(entry.waSessionId);
    }
    await this.clearCodes(organizationId);
    await this.releaseLock(organizationId);
    await this.prisma.waSession.updateMany({
      where: { organizationId, status: 'PAIRING' },
      data: { status: 'DISCONNECTED', lastError: reason },
    });
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
            `WhatsApp reconnect failed for ${organizationId}: ${describe(error)}`,
          );
          this.scheduleReconnect(organizationId, false);
        });
    }, delay);
    timer.unref();
    this.reconnectTimers.set(organizationId, timer);
  }

  /** A link that succeeded, was unlinked or was given up on is over: the
   * next attempt starts with a short retry delay, not one that kept
   * doubling through the last attempt's failures. */
  private forgetRetries(organizationId: string) {
    this.reconnectAttempts.delete(organizationId);
    this.pairingFailures.delete(organizationId);
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
      const session = await this.prisma.waSession
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

  private async clearKeys(waSessionId: string | undefined): Promise<void> {
    if (!waSessionId) return;
    await this.prisma.waAuthKey
      .deleteMany({ where: { sessionId: waSessionId } })
      .catch(() => undefined);
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

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** "code 405: Connection Failure", from a Baileys (Boom) disconnect error. */
function describeDisconnect(error: unknown): string {
  if (!error) return '';
  const code = statusCode(error);
  const message = error instanceof Error ? error.message : '';
  return [code ? `code ${code}` : '', message].filter(Boolean).join(': ');
}
