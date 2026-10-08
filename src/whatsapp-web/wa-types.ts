/**
 * The slice of a Baileys socket this module uses.
 *
 * Declared here rather than taken from Baileys' own types so the rest of
 * the module -- and the specs, which drive fake sockets -- never has to
 * load Baileys: it is an ES module the CommonJS build can only reach
 * through a dynamic import, and a real socket opens a connection to
 * WhatsApp.
 */
export interface WaConnectionUpdate {
  connection?: 'open' | 'connecting' | 'close';
  qr?: string;
  lastDisconnect?: { error?: unknown };
}

export interface WaEventMap {
  'connection.update': WaConnectionUpdate;
}

export interface WaSocket {
  ev: {
    on<E extends keyof WaEventMap>(
      event: E,
      listener: (arg: WaEventMap[E]) => void,
    ): void;
  };
  user?: { id: string } | null;
  sendMessage(
    jid: string,
    content: { text: string },
  ): Promise<{ key?: { id?: string | null } } | undefined>;
  onWhatsApp(
    ...jids: string[]
  ): Promise<Array<{ jid: string; exists: boolean }> | undefined>;
  requestPairingCode(phoneNumber: string): Promise<string>;
  logout(): Promise<void>;
  end(error?: Error): void;
}

export interface WaSocketFactory {
  /** A socket for the gym's linked number, resuming the stored session
   * (by `WaSession.id`) when there is one and starting a fresh pairing
   * when not. */
  create(input: {
    organizationId: string;
    waSessionId: string;
  }): Promise<WaSocket>;
}

export const WA_SOCKET_FACTORY = Symbol('WA_SOCKET_FACTORY');

/** Disconnect reasons this module acts on (Baileys' `DisconnectReason`). */
export const WA_DISCONNECT = {
  LOGGED_OUT: 401,
  FORBIDDEN: 403,
  TIMED_OUT: 408,
  RESTART_REQUIRED: 515,
} as const;

/** The number is not registered on WhatsApp: retrying cannot help. */
export class NotOnWhatsappError extends Error {
  constructor() {
    super("This number isn't on WhatsApp");
    this.name = 'NotOnWhatsappError';
  }
}

/** No open socket for the gym on this server instance right now. */
export class NotLinkedError extends Error {
  constructor(message = 'WhatsApp is not linked right now') {
    super(message);
    this.name = 'NotLinkedError';
  }
}
