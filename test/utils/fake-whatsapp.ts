import type {
  WaEventMap,
  WaSocket,
  WaSocketFactory,
} from '../../src/whatsapp-web/whatsapp-web.types';

/** Stands in for a Baileys socket: records sends, and lets a test play
 * WhatsApp's side by emitting events. */
export class FakeSocket implements WaSocket {
  private readonly listeners = new Map<string, Array<(arg: unknown) => void>>();
  user: { id: string } | null = null;
  sent: Array<{ jid: string; text: string }> = [];
  notOnWhatsapp = new Set<string>();
  pairingRequestedFor: string | null = null;
  loggedOut = false;
  ended = false;

  constructor(readonly organizationId: string) {}

  ev = {
    on: <E extends keyof WaEventMap>(
      event: E,
      listener: (arg: WaEventMap[E]) => void,
    ) => {
      const list = this.listeners.get(event) ?? [];
      list.push(listener as (arg: unknown) => void);
      this.listeners.set(event, list);
    },
  };

  emit<E extends keyof WaEventMap>(event: E, arg: WaEventMap[E]) {
    for (const listener of this.listeners.get(event) ?? []) listener(arg);
  }

  sendMessage(jid: string, content: { text: string }) {
    this.sent.push({ jid, text: content.text });
    return Promise.resolve({ key: { id: `FAKE${this.sent.length}` } });
  }

  onWhatsApp(jid: string) {
    const digits = jid.split('@')[0];
    return Promise.resolve([{ jid, exists: !this.notOnWhatsapp.has(digits) }]);
  }

  requestPairingCode(phoneNumber: string) {
    this.pairingRequestedFor = phoneNumber;
    return Promise.resolve('ABCD1234');
  }

  logout() {
    this.loggedOut = true;
    return Promise.resolve();
  }

  end() {
    this.ended = true;
  }
}

export async function eventually<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  ms = 10_000,
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() - start > ms)
      throw new Error(`Timed out; last value: ${JSON.stringify(value)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** A factory handing out FakeSockets, with the list of every one made. */
export function fakeWhatsapp() {
  const sockets: FakeSocket[] = [];
  const factory: WaSocketFactory = {
    create: (organizationId) => {
      const socket = new FakeSocket(organizationId);
      sockets.push(socket);
      return Promise.resolve(socket);
    },
  };
  const socketFor = (organizationId: string) =>
    [...sockets].reverse().find((s) => s.organizationId === organizationId)!;
  return { sockets, factory, socketFor };
}
