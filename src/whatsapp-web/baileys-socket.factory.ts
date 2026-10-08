import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { parseWaAuthKey, WaAuthStore } from './wa-auth.store';
import type { WaSocket, WaSocketFactory } from './wa-types';

type Baileys = typeof import('baileys');

/**
 * Opens real Baileys sockets.
 *
 * Baileys is an ES module and this build is CommonJS, so it is loaded
 * with a dynamic `import()` -- which also means a deployment that never
 * links WhatsApp never loads it at all.
 */
@Injectable()
export class BaileysSocketFactory implements WaSocketFactory {
  private readonly logger = new Logger('Baileys');
  private lib?: Promise<Baileys>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private load(): Promise<Baileys> {
    this.lib ??= import('baileys');
    return this.lib;
  }

  async create(input: {
    organizationId: string;
    waSessionId: string;
  }): Promise<WaSocket> {
    const lib = await this.load();
    const store = new WaAuthStore(
      this.prisma,
      input.waSessionId,
      parseWaAuthKey(this.config.get<string>('WA_AUTH_KEY')),
    );
    const { state, saveCreds } = await encryptedAuthState(store, lib);
    const logger = baileysLogger(this.logger);
    // The WhatsApp Web version Baileys pins can fall behind the one
    // WhatsApp accepts; ask for the current one, and fall back to the
    // pinned version if that lookup fails.
    const latest = await lib.fetchLatestBaileysVersion().catch(() => null);

    const socket = lib.makeWASocket({
      auth: {
        creds: state.creds,
        keys: lib.makeCacheableSignalKeyStore(state.keys, logger),
      },
      logger,
      // Named honestly: this is what the gym sees under Linked devices.
      browser: ['THE CULT CLIENT', 'Chrome', '1.0'],
      markOnlineOnConnect: false,
      // Fail a connection attempt that gets no answer, so it is reported
      // instead of hanging.
      connectTimeoutMs: 20_000,
      syncFullHistory: false,
      ...(latest?.version ? { version: latest.version } : {}),
    });
    socket.ev.on('creds.update', () => void saveCreds());
    return socket as unknown as WaSocket;
  }
}

/** Baileys' `useMultiFileAuthState`, backed by the encrypted store. */
async function encryptedAuthState(store: WaAuthStore, lib: Baileys) {
  const { BufferJSON, initAuthCreds, proto } = lib;
  const parse = (raw: string | null | undefined) =>
    raw ? (JSON.parse(raw, BufferJSON.reviver) as unknown) : null;
  const serialise = (value: unknown) =>
    JSON.stringify(value, BufferJSON.replacer);

  const creds =
    (parse(await store.read('creds')) as ReturnType<typeof initAuthCreds>) ??
    initAuthCreds();

  type KeyStore = Parameters<Baileys['makeCacheableSignalKeyStore']>[0];
  const keys: KeyStore = {
    get: (async (type: string, ids: string[]) => {
      const found = await store.readMany(ids.map((id) => `${type}-${id}`));
      const out: Record<string, unknown> = {};
      for (const id of ids) {
        let value = found.get(`${type}-${id}`);
        if (type === 'app-state-sync-key' && value) {
          value = proto.Message.AppStateSyncKeyData.fromObject(
            JSON.parse(value),
          ) as unknown as string;
        }
        if (value) out[id] = value;
      }
      return out;
    }) as KeyStore['get'],
    set: async (data) => {
      const entries: Record<string, string | null> = {};
      for (const [category, values] of Object.entries(data)) {
        for (const [id, value] of Object.entries(values ?? {})) {
          entries[`${category}-${id}`] = value ? serialise(value) : null;
        }
      }
      await store.writeBatch(entries);
    },
  };

  return {
    state: { creds, keys },
    saveCreds: () => store.write('creds', serialise(creds)),
  };
}

/** Baileys logs through pino's interface; only warnings and errors are
 * worth the log volume, and they go through Nest's logger like the rest
 * of the app. */
function baileysLogger(nest: Logger) {
  const logger = {
    level: 'warn',
    child: () => logger,
    trace: () => undefined,
    debug: () => undefined,
    info: () => undefined,
    warn: (obj: unknown, msg?: string) => nest.warn(msg ?? stringify(obj)),
    error: (obj: unknown, msg?: string) => nest.error(msg ?? stringify(obj)),
  };
  return logger as unknown as Parameters<
    Baileys['makeCacheableSignalKeyStore']
  >[1];
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
