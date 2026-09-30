/**
 * The slice of a Baileys socket this module uses.
 *
 * Declared here rather than taken from Baileys' own types so the rest of
 * the module -- and the e2e suite, which drives a fake socket -- never has
 * to load Baileys: it is an ES module the CommonJS build can only reach
 * through a dynamic import, and a real socket opens a connection to
 * WhatsApp.
 */
export interface WaConnectionUpdate {
  connection?: 'open' | 'connecting' | 'close';
  qr?: string;
  lastDisconnect?: { error?: unknown };
}

export interface WaMessageKey {
  id?: string | null;
  fromMe?: boolean | null;
  remoteJid?: string | null;
  /** Baileys 7 addresses chats by LID and carries the phone JID here. */
  remoteJidAlt?: string | null;
  senderPn?: string | null;
}

export interface WaMessage {
  key: WaMessageKey;
  message?: {
    conversation?: string | null;
    extendedTextMessage?: { text?: string | null } | null;
  } | null;
}

export interface WaMessageUpdate {
  key: WaMessageKey;
  update: { status?: number | null };
}

export interface WaEventMap {
  'connection.update': WaConnectionUpdate;
  'messages.upsert': { messages: WaMessage[]; type: string };
  'messages.update': WaMessageUpdate[];
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
  /** A socket for the organization's linked number, resuming its stored
   * session when there is one and starting a fresh pairing when not. */
  create(organizationId: string): Promise<WaSocket>;
}

export const WA_SOCKET_FACTORY = Symbol('WA_SOCKET_FACTORY');

/** WhatsApp's receipt levels, as Baileys reports them on `messages.update`. */
export const WA_ACK = { SERVER: 2, DELIVERED: 3, READ: 4, PLAYED: 5 } as const;

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
export class WhatsappWebNotReadyError extends Error {
  constructor(message = 'WhatsApp Web is not connected right now') {
    super(message);
    this.name = 'WhatsappWebNotReadyError';
  }
}

export interface SendWhatsappWebJob {
  organizationId: string;
  messageLogId: string;
  /** Digits only, with country code. */
  to: string;
  text: string;
}
